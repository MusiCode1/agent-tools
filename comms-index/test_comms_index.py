#!/usr/bin/env python3
"""בדיקות ל-comms-index ולארכיון ה-SMS שבטלפון. נתונים סינתטיים בלבד."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = Path(__file__).resolve().parent
TOOL = HERE / "comms-index"
PHONE = HERE / "phone" / "sms-archive.py"


def load_tool():
    loader = importlib.machinery.SourceFileLoader("comms_index_mod", str(TOOL))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


ci = load_tool()

WACLI_SCHEMA = """
create table chats (jid text primary key, kind text, name text);
create table contacts (jid text primary key, phone text, push_name text, full_name text, first_name text,
                       business_name text, system_name text, updated_at integer);
create table contact_aliases (jid text primary key, alias text not null, notes text, updated_at integer);
create table messages (rowid integer primary key autoincrement, chat_jid text not null, chat_name text,
                       msg_id text not null, sender_jid text, sender_name text, ts integer not null,
                       from_me integer not null, text text, display_text text, media_caption text, filename text,
                       revoked integer not null default 0, deleted_for_me integer not null default 0,
                       unique(chat_jid, msg_id));
"""


def make_wacli(path):
    con = sqlite3.connect(path)
    con.executescript(WACLI_SCHEMA)
    con.executemany("insert into chats(jid, kind, name) values (?,?,?)", [
        ("111@s.whatsapp.net", "dm", "דנה"),
        ("999@g.us", "group", "ועד הבית"),
    ])
    con.executemany("insert into contacts(jid, push_name) values (?,?)", [("222@s.whatsapp.net", "Example Shop")])
    rows = [
        ("111@s.whatsapp.net", "m1", "111@s.whatsapp.net", "", 1700000000, 0, "נקבעה פגישה ביום שני", "", ""),
        ("111@s.whatsapp.net", "m2", "", "", 1700000100, 1, "אני מאחר לפגישה", "", ""),
        ("999@g.us", "m3", "222@s.whatsapp.net", "", 1700000200, 0, "", "חשבונית מצורפת", "invoice.pdf"),
        ("999@g.us", "m4", "333@s.whatsapp.net", "שכן", 1700000300, 0, "", "", ""),   # תבנית בלבד
        ("999@g.us", "m5", "333@s.whatsapp.net", "שכן", 1700000400, 0, "הודעה שנמחקה", "", ""),
    ]
    con.executemany("insert into messages(chat_jid, msg_id, sender_jid, sender_name, ts, from_me, text, "
                    "media_caption, filename, display_text) values (?,?,?,?,?,?,?,?,?, '(message)')", rows)
    con.execute("update messages set revoked=1 where msg_id='m5'")
    con.commit()
    con.close()


class WhatsAppSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="comms-index-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.wa = self.dir / "wacli.db"
        make_wacli(self.wa)
        self.con = ci.open_db(str(self.dir / "comms.db"))

    def sync(self, **kw):
        res = ci.sync_rows(self.con, "wa", "personal", ci.wa_rows(str(self.wa)), **kw)
        self.con.commit()
        return res

    def fts(self, q):
        return [r[0] for r in self.con.execute(
            "select m.ext_id from messages m join messages_fts f on f.rowid=m.id where messages_fts match ?", (q,))]

    def test_initial_sync_skips_deleted_and_template_rows(self):
        ins, upd, dele, total = self.sync()
        self.assertEqual((ins, upd, dele, total), (3, 0, 0, 3))
        got = {r[0]: r[1:] for r in self.con.execute(
            "select ext_id, conv_name, sender, from_me, text from messages")}
        self.assertEqual(got["111@s.whatsapp.net/m1"], ("דנה", "דנה", 0, "נקבעה פגישה ביום שני"))
        self.assertEqual(got["111@s.whatsapp.net/m2"], ("דנה", "", 1, "אני מאחר לפגישה"))
        self.assertEqual(got["999@g.us/m3"], ("ועד הבית", "Example Shop", 0, "חשבונית מצורפת\ninvoice.pdf"))
        self.assertNotIn("999@g.us/m5", got)
        self.assertEqual(sorted(self.fts('"פגישה"')), ["111@s.whatsapp.net/m1", "111@s.whatsapp.net/m2"])

    def test_edit_and_revoke_are_mirrored(self):
        self.sync()
        ref_before = self.con.execute("select ref from messages where ext_id='111@s.whatsapp.net/m1'").fetchone()
        src = sqlite3.connect(self.wa)
        src.execute("update messages set text='הפגישה נדחתה' where msg_id='m1'")
        src.execute("update messages set revoked=1 where msg_id='m2'")
        src.commit()
        src.close()
        ins, upd, dele, total = self.sync()
        self.assertEqual((ins, upd, dele, total), (0, 1, 1, 2))
        self.assertEqual(self.fts('"נדחתה"'), ["111@s.whatsapp.net/m1"])
        self.assertEqual(self.fts('"מאחר"'), [])
        ref_after = self.con.execute("select ref from messages where ext_id='111@s.whatsapp.net/m1'").fetchone()
        self.assertEqual(ref_before, ref_after, "המזהה חייב להישאר יציב אחרי עריכה")

    def test_empty_source_does_not_wipe_index(self):
        self.sync()
        with self.assertRaises(ci.ShrinkError):
            ci.sync_rows(self.con, "wa", "personal", [])
        self.assertEqual(self.con.execute("select count(*) from messages").fetchone()[0], 3)
        ci.sync_rows(self.con, "wa", "personal", [], allow_shrink=True)
        self.con.commit()
        self.assertEqual(self.con.execute("select count(*) from messages").fetchone()[0], 0)

    def test_large_deletion_is_refused(self):
        rows = [(f"c/{i}", "c", "conv", "s", 0, 1700000000 + i, f"הודעה מספר {i}") for i in range(300)]
        ci.sync_rows(self.con, "wa", "big", rows)
        self.con.commit()
        with self.assertRaises(ci.ShrinkError):
            ci.sync_rows(self.con, "wa", "big", rows[:150])
        self.assertEqual(self.con.execute("select count(*) from messages where account='big'").fetchone()[0], 300)

    def test_missing_wacli_db_is_a_source_error(self):
        with self.assertRaises(ci.SourceError):
            ci.wa_rows(str(self.dir / "nope.db"))


def make_archive(path, sms, contacts):
    con = sqlite3.connect(path)
    con.executescript("""
      create table sms(id integer not null, received text not null, ts integer not null, thread_id integer,
                       type text, read integer, address text, body text, first_seen integer not null,
                       primary key (id, received));
      create table contacts(number text not null, name text not null);
      create table meta(key text primary key, value text);""")
    con.executemany("insert into sms values (?,?,?,?,?,?,?,?,0)", sms)
    con.executemany("insert into contacts values (?,?)", contacts)
    con.execute("insert into meta values ('last_run', '1700000000')")
    con.commit()
    con.close()


class SmsImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="comms-index-sms-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.sms = [
            (1, "2026-01-01 10:00:00", 1767254400, 7, "inbox", 1, "0500000001", "התור שלך נקבע"),
            (2, "2026-01-01 10:05:00", 1767254700, 7, "sent", 1, "+972500000001", "תודה"),
            (3, "2026-01-02 09:00:00", 1767337200, 8, "inbox", 0, "EXAMPLEBANK", "קוד אימות 1234"),
            (4, "2026-01-02 09:01:00", 1767337260, 8, "inbox", 0, "EXAMPLEBANK", "   "),
        ]
        make_archive(self.dir / "archive.db", self.sms, [("+972-50-000-0001", "דנה")])

    def test_rows_resolve_contacts_and_direction(self):
        rows = {r[0]: r for r in ci.sms_rows(str(self.dir / "archive.db"))}
        self.assertEqual(set(rows), {"1:2026-01-01 10:00:00", "2:2026-01-01 10:05:00", "3:2026-01-02 09:00:00"})
        _, conv_id, conv, sender, from_me, ts, text = rows["1:2026-01-01 10:00:00"]
        self.assertEqual((conv_id, conv, sender, from_me), ("7", "דנה", "דנה", False))
        self.assertEqual(rows["2:2026-01-01 10:05:00"][2:5], ("דנה", "", True))
        self.assertEqual(rows["3:2026-01-02 09:00:00"][2], "EXAMPLEBANK")

    def test_norm_number(self):
        self.assertEqual(ci.norm_number("+972-50-000-0001"), "0500000001")
        self.assertEqual(ci.norm_number("050 000 0001"), "0500000001")
        self.assertEqual(ci.norm_number("ExampleBank"), "examplebank")

    def test_pull_validates_and_refuses_shrink(self):
        local = self.dir / "state" / "sms-archive.db"
        cfg = {"db_path": str(self.dir / "state" / "comms.db"),
               "sms": {"account": "phone", "pull_interval_min": 15, "local_copy": str(local),
                       "routes": [{"type": "ssh", "host": "phone.invalid"}]}}
        con = ci.open_db(cfg["db_path"])
        source = {"path": self.dir / "archive.db"}
        orig = ci.phone_fetch
        ci.phone_fetch = lambda route, dest: shutil.copyfile(source["path"], dest)
        self.addCleanup(setattr, ci, "phone_fetch", orig)
        self.assertEqual(ci.pull_sms(cfg, con, force=True, quiet=True), "ok")
        self.assertTrue(local.exists())
        self.assertEqual(ci.pull_sms(cfg, con), "skip", "בתוך המרווח אין משיכה")
        make_archive(self.dir / "small.db", self.sms[:1], [])
        source["path"] = self.dir / "small.db"
        before = local.read_bytes()
        with self.assertRaises(ci.PullError):
            ci.pull_sms(cfg, con, force=True, quiet=True)
        self.assertEqual(local.read_bytes(), before, "עותק קטן יותר לא מחליף את הקיים")
        (self.dir / "junk.db").write_bytes(b"not a database at all" * 300)
        source["path"] = self.dir / "junk.db"
        with self.assertRaises(ci.PullError):
            ci.pull_sms(cfg, con, force=True, quiet=True)
        st = ci.state_get(con, "sms", "phone")
        self.assertIn("SQLite", st["last_pull_error"])
        self.assertEqual(st["archive_rows"], "4")


FAKE_SMS_LIST = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    if os.environ.get("FAKE_SMS_ERROR"):
        print(json.dumps({"error": "permission denied"})); sys.exit(0)
    msgs = json.load(open(os.environ["FAKE_SMS"]))
    args = sys.argv[1:]
    for a in args:
        if a.startswith("--message-selection") and "=" not in a:
            sys.exit(64)                                                # כמו האמיתי: רק הצורה עם '='
    if "--message-selection=length(address)>0" in args:
        msgs = [m for m in msgs if m["address"]]
    limit = int(args[args.index("-l") + 1]) if "-l" in args else 10
    offset = int(args[args.index("-o") + 1]) if "-o" in args else 0
    msgs.sort(key=lambda m: (m["received"], m["_id"]), reverse=True)   # date DESC, כמו ב-Android
    page = msgs[offset:offset + limit][::-1]                            # וה-API הופך את הסדר
    out = []
    for m in page:
        if not m["address"]:                                            # האמיתי נופל באמצע הפלט
            sys.stdout.write("[" + ",".join(json.dumps(x) for x in out)); sys.exit(0)
        out.append(m)
    print(json.dumps(out))
""")
FAKE_RISH = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, re, sys, time
    cmd = sys.argv[2]
    if os.environ.get("FAKE_RISH_FLAKY"):                               # כמו האמיתי: פלט שנעלם
        counter = os.environ["FAKE_RISH_FLAKY"]
        n = int(open(counter).read()) if os.path.exists(counter) else 0
        open(counter, "w").write(str(n + 1))
        if n % 3 == 1:
            sys.exit(0)
    msgs = [m for m in json.load(open(os.environ["FAKE_SMS"])) if not m["address"]]
    one = re.search(r"_id=(\\d+)'", cmd)
    if one:
        msgs = [m for m in msgs if m["_id"] == int(one.group(1))]
        for i, m in enumerate(msgs):
            date = int(time.mktime(time.strptime(m["received"], "%Y-%m-%d %H:%M:%S"))) * 1000 + 123
            print(f"Row: {i} _id={m['_id']}, thread_id={m['threadid']}, type=1, read=0, date={date}, body={m['body']}")
    else:
        for i, m in enumerate(msgs):
            print(f"Row: {i} _id={m['_id']}")
""")
FAKE_CONTACTS = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json
    print(json.dumps([{"name": "דנה", "number": "+972 50-000-0001"}]))
""")


class PhoneArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sms-archive-test-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        for name, body in (("termux-sms-list", FAKE_SMS_LIST), ("termux-contact-list", FAKE_CONTACTS),
                           ("rish", FAKE_RISH)):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.fixture = self.dir / "sms.json"
        self.archive = self.dir / "home" / "sms-archive"

    def write_msgs(self, msgs):
        self.fixture.write_text(json.dumps(msgs, ensure_ascii=False))

    @staticmethod
    def msg(i, day=1, minute=None):
        minute = i % 60 if minute is None else minute
        return {"_id": i, "threadid": i % 5, "type": "inbox", "read": True, "address": "0500000001",
                "number": "0500000001", "received": f"2026-01-{day:02d} {i // 60 % 24:02d}:{minute:02d}:00",
                "body": f"הודעה סינתטית {i}"}

    def run_archive(self, *args, error=False, rish=True, flaky=False):
        env = {**os.environ, "HOME": str(self.dir / "home"), "SMS_ARCHIVE_BIN": str(self.bin),
               "SMS_ARCHIVE_RISH": str(self.bin / ("rish" if rish else "no-such-rish")),
               "FAKE_SMS": str(self.fixture), "TZ": "Asia/Jerusalem"}
        if error:
            env["FAKE_SMS_ERROR"] = "1"
        if flaky:
            env["FAKE_RISH_FLAKY"] = str(self.dir / "rish-calls")
        return subprocess.run([sys.executable, str(PHONE), *args], env=env, text=True, capture_output=True)

    def test_no_address_messages_come_through_rish(self):
        msgs = [self.msg(i) for i in range(1, 700)]
        blank = {**self.msg(650, day=3), "_id": 9001, "address": "", "number": "", "body": "הודעת מערכת"}
        self.write_msgs(msgs + [blank])
        r = self.run_archive("run", "--full", rish=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        n, meta = self.rows()
        self.assertEqual(n, 699, "הקריאה הראשית לא נקטעת בגלל הודעה בלי כתובת")
        self.assertIn("FileNotFoundError", meta["no_address_error"])
        self.assertNotIn("הודעת מערכת", (self.archive / "archive.log").read_text(), "בלי תוכן בלוג")
        r = self.run_archive("run", "--full")
        self.assertEqual(r.returncode, 0, r.stderr)
        n, meta = self.rows()
        self.assertEqual((n, meta["no_address_error"]), (700, ""))
        con = sqlite3.connect(self.archive / "sms.snapshot.db")
        row = con.execute("select address, body, received from sms where id=9001").fetchone()
        con.close()
        self.assertEqual(row, ("", "הודעת מערכת", blank["received"]))

    def test_flaky_rish_still_archives_every_no_address_message(self):
        blanks = [{**self.msg(600 + k, day=3), "_id": 9000 + k, "address": "", "number": "",
                   "body": f"הודעת מערכת {k}"} for k in range(3)]
        self.write_msgs([self.msg(i) for i in range(1, 20)] + blanks)
        r = self.run_archive("run", "--full", flaky=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        n, meta = self.rows()
        self.assertEqual((n, meta["no_address_error"]), (22, ""))

    def rows(self):
        con = sqlite3.connect(self.archive / "sms.snapshot.db")
        try:
            return (con.execute("select count(*) from sms").fetchone()[0],
                    dict(con.execute("select key, value from meta")))
        finally:
            con.close()

    def test_full_then_incremental_with_reused_id(self):
        self.write_msgs([self.msg(i) for i in range(1, 1201)])
        r = self.run_archive("run", "--full")
        self.assertEqual(r.returncode, 0, r.stderr)
        n, meta = self.rows()
        self.assertEqual((n, meta["total"], meta["last_new"]), (1200, "1200", "1200"))
        contacts = sqlite3.connect(self.archive / "sms.snapshot.db").execute("select * from contacts").fetchall()
        self.assertEqual(contacts, [("+972 50-000-0001", "דנה")])
        # ההודעה האחרונה נמחקה בטלפון, וה-_id שלה ניתן להודעה חדשה: שתיהן נשמרות
        msgs = [self.msg(i) for i in range(1, 1200)] + [self.msg(1200, day=2), self.msg(1201, day=2)]
        self.write_msgs(msgs)
        r = self.run_archive("run")
        self.assertEqual(r.returncode, 0, r.stderr)
        n, meta = self.rows()
        self.assertEqual((n, meta["last_new"]), (1202, "2"))
        self.assertIn("ok new=2", (self.archive / "archive.log").read_text())

    def test_unchanged_run_keeps_snapshot(self):
        self.write_msgs([self.msg(i) for i in range(1, 30)])
        self.assertEqual(self.run_archive("run").returncode, 0)
        before = (self.archive / "sms.snapshot.db").stat().st_mtime_ns
        self.assertEqual(self.run_archive("run").returncode, 0)
        self.assertEqual((self.archive / "sms.snapshot.db").stat().st_mtime_ns, before)

    def test_api_error_is_recorded_in_snapshot(self):
        self.write_msgs([self.msg(i) for i in range(1, 5)])
        self.assertEqual(self.run_archive("run").returncode, 0)
        r = self.run_archive("run", error=True)
        self.assertEqual(r.returncode, 1)
        n, meta = self.rows()
        self.assertEqual(n, 4)
        self.assertIn("permission denied", meta["last_error"])
        status = json.loads(self.run_archive("status").stdout)
        self.assertEqual(status["total"], 4)
        self.assertIn("permission denied", status["last_error"])


class CliTest(unittest.TestCase):
    def test_update_and_status(self):
        with tempfile.TemporaryDirectory(prefix="comms-index-cli-") as d:
            d = Path(d)
            make_wacli(d / "wacli.db")
            cfg = d / "config.json"
            cfg.write_text(json.dumps({"db_path": str(d / "state" / "comms.db"),
                                       "whatsapp": [{"account": "personal", "db": str(d / "wacli.db")}]}))
            env = {**os.environ, "COMMS_INDEX_CONFIG": str(cfg), "HOME": str(d)}
            r = subprocess.run([sys.executable, str(TOOL), "update"], env=env, text=True, capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("wa/personal: 3", r.stdout)
            self.assertEqual(oct((d / "state" / "comms.db").stat().st_mode & 0o777), "0o600")
            r = subprocess.run([sys.executable, str(TOOL), "status", "--json"], env=env, text=True,
                               capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            src = json.loads(r.stdout)["sources"][0]
            self.assertEqual((src["source"], src["account"], src["messages"]), ("wa", "personal", 3))


if __name__ == "__main__":
    unittest.main()
