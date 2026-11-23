#!/data/data/com.termux/files/usr/bin/python3
"""sms-archive — ארכיון SMS מצטבר על הטלפון (Termux + Termux:API).

כל הודעה שנראתה אי-פעם נשמרת, גם אם נמחקה אחר כך מהטלפון.
המפתח הוא (_id, received): ‏Android עלול לתת _id של הודעה שנמחקה להודעה חדשה.
כל ריצה עוברת על דפים מהחדש לישן ונעצרת בדף הראשון שיש בו הודעה מוכרת.
בסוף נכתב עותק עקבי (VACUUM INTO). אותו מעתיקים החוצה, לא את ה-DB החי.

🛑 הודעה בלי כתובת שולח מפילה את termux-sms-list באמצע הפלט (חיפוש איש קשר לפי
מחרוזת ריקה), והדף כולו נקטע. ⇒ הקריאה הראשית מסננת אותן, והן נקראות בנפרד
דרך rish (Shizuku). אין rish ⇒ הן מדולגות, והשגיאה נרשמת ב-meta.

מותקן ומתוזמן בידי `comms-index sms-install`; ‏termux-job-scheduler מריץ את run.sh.
🔒 שום הודעת שגיאה כאן אינה כוללת תוכן הודעה: הלוג וה-meta יוצאים מהטלפון.
"""
import argparse, fcntl, json, os, re, sqlite3, subprocess, sys, time

HOME = os.environ.get("HOME") or "/data/data/com.termux/files/home"
DIR = os.environ.get("SMS_ARCHIVE_DIR") or os.path.join(HOME, "sms-archive")
BIN = os.environ.get("SMS_ARCHIVE_BIN") or "/data/data/com.termux/files/usr/bin"
RISH = os.environ.get("SMS_ARCHIVE_RISH") or os.path.join(HOME, "rish")
WITH_ADDRESS = "--message-selection=length(address)>0"     # הצורה עם '=' — רווח אינו נתמך
TYPES = {1: "inbox", 2: "sent", 3: "draft", 4: "outbox", 5: "failed", 6: "queued"}
DB = os.path.join(DIR, "sms.db")
SNAP = os.path.join(DIR, "sms.snapshot.db")
LOG = os.path.join(DIR, "archive.log")
PAGE = 500
CONTACTS_EVERY = 6 * 3600
SNAP_EVERY = 3600
LOG_MAX = 256 * 1024
VERSION = 1

SCHEMA = """
create table if not exists sms(
  id integer not null,
  received text not null,
  ts integer not null,
  thread_id integer,
  type text,
  read integer,
  address text,
  body text,
  first_seen integer not null,
  primary key (id, received)
);
create table if not exists contacts(number text not null, name text not null);
create table if not exists meta(key text primary key, value text);
"""


def log(msg):
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX:
            with open(LOG, "rb") as f:
                f.seek(-(LOG_MAX // 2), os.SEEK_END)
                tail = f.read()
            with open(LOG, "wb") as f:
                f.write(tail[tail.find(b"\n") + 1:])
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def api(cmd, *args, timeout=180):
    out = subprocess.run([os.path.join(BIN, cmd), *args], capture_output=True, text=True,
                         timeout=timeout, stdin=subprocess.DEVNULL)
    if out.returncode != 0:
        raise RuntimeError(f"{cmd} {' '.join(args)}: rc={out.returncode} {out.stderr.strip()[:200]}")
    try:
        data = json.loads(out.stdout or "[]")
    except json.JSONDecodeError as e:
        # 🔒 בלי הפלט עצמו — הוא תוכן הודעות
        raise RuntimeError(f"{cmd} {' '.join(args)}: JSON קטוע או פגום "
                           f"({e.msg}, מקום {e.pos} מתוך {len(out.stdout)})") from None
    if isinstance(data, dict):             # Termux:API מחזיר {"error": ...} למשל כשאין הרשאה
        raise RuntimeError(f"{cmd}: {str(data.get('error') or sorted(data))[:200]}")
    return data


def rish(cmd, timeout=60):
    out = subprocess.run([RISH, "-c", cmd], capture_output=True, text=True, timeout=timeout,
                         stdin=subprocess.DEVNULL)
    if out.returncode != 0:
        raise RuntimeError(f"rish rc={out.returncode}: {out.stderr.strip()[-160:]}")
    return out.stdout


ROW_RE = re.compile(r"Row: \d+ _id=(\d+), thread_id=(-?\d+|NULL), type=(\d+), read=(\d+), "
                    r"date=(\d+), body=(.*)", re.S)


def no_address_messages(id_reads=4, tries=8):
    """הודעות בלי כתובת שולח, דרך content query כ-uid 2000. מחזיר (הודעות, מזהים שנכשלו).

    🛑 rish מאבד פלט: נמדד שליש מהקריאות ריקות או חלקיות, ו-sleep בסוף הפקודה אינו
    עוזר. ⇒ רשימת המזהים היא איחוד של כמה קריאות, וכל הודעה נקלטת רק כשאותו פלט
    מלא חזר פעמיים — קטיעה אקראית אינה חוזרת זהה, ולכן גוף קטוע אינו נשמר.
    """
    ids = set()
    for _ in range(id_reads):
        ids |= {int(x) for x in re.findall(r"_id=(\d+)", rish(
            "content query --uri content://sms --projection _id --where 'length(address)=0'"))}
    out, failed = [], []
    for i in sorted(ids):
        seen, got = {}, None
        for _ in range(tries):
            raw = rish("content query --uri content://sms "
                       f"--projection _id:thread_id:type:read:date:body --where '_id={i}'")
            m = ROW_RE.search(raw)
            if not m or int(m[1]) != i or not raw.endswith("\n") or len(raw.encode()) >= 4000:
                continue
            seen[m.groups()] = seen.get(m.groups(), 0) + 1
            if seen[m.groups()] >= 2:
                got = m
                break
        if got is None:
            failed.append(i)
            continue
        out.append({"_id": i, "threadid": None if got[2] == "NULL" else int(got[2]),
                    "type": TYPES.get(int(got[3]), got[3]), "read": got[4] == "1", "address": "",
                    "received": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(got[5]) // 1000)),
                    "body": got[6].rstrip("\n")})
    return out, failed


def to_ts(received):
    """'YYYY-MM-DD HH:MM:SS' בשעון המקומי של הטלפון → שניות מאז 1970."""
    return int(time.mktime(time.strptime(received, "%Y-%m-%d %H:%M:%S")))


def meta_set(con, **kv):
    con.executemany("insert into meta(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
                    [(k, str(v)) for k, v in kv.items()])


def archive_page(con, page, now):
    new = changed = 0
    for m in page:
        key = (int(m["_id"]), str(m["received"]))
        vals = (m.get("threadid"), m.get("type"), int(bool(m.get("read"))),
                m.get("address") or m.get("number") or "", m.get("body") or "")
        old = con.execute("select thread_id, type, read, address, body from sms where id=? and received=?",
                          key).fetchone()
        if old is None:
            con.execute("insert into sms(id, received, ts, thread_id, type, read, address, body, first_seen) "
                        "values (?,?,?,?,?,?,?,?,?)", key + (to_ts(key[1]),) + vals + (now,))
            new += 1
        elif tuple(old) != vals:
            con.execute("update sms set thread_id=?, type=?, read=?, address=?, body=? where id=? and received=?",
                        vals + key)
            changed += 1
    return new, changed


def refresh_contacts(con, now, force):
    last = con.execute("select value from meta where key='contacts_at'").fetchone()
    if not force and last and now - int(last[0]) < CONTACTS_EVERY:
        return False
    rows = sorted({(str(p.get("number") or "").strip(), str(p.get("name") or "").strip())
                   for p in api("termux-contact-list")})
    rows = [r for r in rows if r[0] and r[1]]
    meta_set(con, contacts_at=now)
    if [tuple(r) for r in con.execute("select number, name from contacts order by number, name")] == rows:
        return False
    con.execute("delete from contacts")
    con.executemany("insert into contacts(number, name) values (?, ?)", rows)
    return True


def snapshot(con):
    tmp = SNAP + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con.execute("vacuum into ?", (tmp,))
    os.chmod(tmp, 0o600)
    os.replace(tmp, SNAP)


def run(full):
    os.makedirs(DIR, mode=0o700, exist_ok=True)
    lock = os.open(os.path.join(DIR, ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("skip: ריצה אחרת פעילה")
        return 0
    t0 = time.time()
    now = int(t0)
    con = sqlite3.connect(DB, timeout=30)
    con.executescript(SCHEMA)
    try:
        new = changed = offset = 0
        while True:
            page = api("termux-sms-list", WITH_ADDRESS, "-l", str(PAGE), "-o", str(offset))
            n_new, n_changed = archive_page(con, page, now)
            new, changed = new + n_new, changed + n_changed
            if len(page) < PAGE or (not full and n_new < len(page)):
                break
            offset += PAGE
        last = con.execute("select value from meta where key='no_address_at'").fetchone()
        if full or not last or now - int(last[0]) >= CONTACTS_EVERY:
            try:
                msgs, failed = no_address_messages()
                n_new, n_changed = archive_page(con, msgs, now)
                new, changed = new + n_new, changed + n_changed
                err = f"{len(failed)} הודעות לא נקראו גם אחרי ניסיונות חוזרים (rish): {failed[:10]}" if failed else ""
                meta_set(con, no_address_error=err)
                if failed:                  # בלי עדכון no_address_at — הריצה הבאה תנסה שוב
                    log(f"warn: {err}")
                else:
                    meta_set(con, no_address_at=now)
            except (OSError, RuntimeError, subprocess.SubprocessError) as e:
                meta_set(con, no_address_at=now, no_address_error=f"{type(e).__name__}: {e}"[:300])
                log(f"warn: הודעות בלי כתובת לא נקראו: {e}")
        contacts = refresh_contacts(con, now, full)
        total = con.execute("select count(*) from sms").fetchone()[0]
        meta_set(con, last_run=now, last_ok=now, last_new=new, total=total, version=VERSION, last_error="")
        con.commit()
        # גם בלי שינוי — פעם בשעה, כדי שהצד השני יראה שהארכיון חי (meta.last_run)
        stale = not os.path.exists(SNAP) or now - os.path.getmtime(SNAP) > SNAP_EVERY
        if new or changed or contacts or stale:
            snapshot(con)
        log(f"ok new={new} changed={changed} contacts={'updated' if contacts else 'same'} "
            f"total={total} secs={time.time() - t0:.1f}")
        return 0
    except Exception as e:
        con.rollback()
        meta_set(con, last_run=now, last_error=f"{type(e).__name__}: {e}"[:500])
        con.commit()
        snapshot(con)                       # כדי שהשגיאה תגיע גם לצד השני
        log(f"error: {type(e).__name__}: {e}")
        print(f"sms-archive: {e}", file=sys.stderr)
        return 1


def status():
    if not os.path.exists(DB):
        print(json.dumps({"total": 0, "error": "אין ארכיון"}, ensure_ascii=False))
        return 1
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    meta = dict(con.execute("select key, value from meta"))
    print(json.dumps({"total": int(meta.get("total") or 0), "last_run": meta.get("last_run"),
                      "last_new": meta.get("last_new"), "last_error": meta.get("last_error", ""),
                      "no_address_error": meta.get("no_address_error", ""),
                      "newest": con.execute("select max(received) from sms").fetchone()[0],
                      "contacts": con.execute("select count(*) from contacts").fetchone()[0]},
                     ensure_ascii=False))
    return 0


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(prog="sms-archive", description="ארכיון SMS מצטבר על הטלפון")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--full", action="store_true", help="לעבור על כל ההודעות ולרענן אנשי קשר")
    sub.add_parser("status")
    a = p.parse_args()
    return run(a.full) if a.cmd == "run" else status()


if __name__ == "__main__":
    sys.exit(main())
