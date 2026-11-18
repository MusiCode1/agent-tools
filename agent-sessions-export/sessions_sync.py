#!/usr/bin/env python3
"""sessions_sync — incremental, preserving sync of the agent-sessions search DB between machines.

Each machine exports only rows of *its own* machine (sessions.machine = config.machine),
newer than a cursor on the source's `messages.updated_at`. The importer keeps the
semantics of the 2026-11-02 one-time merge (merge.py): new rows are copied with their
original keys (user/assistant text also into messages_fts, which has no triggers);
existing messages only get NULL columns and missing JSON keys filled, never overwritten,
and differing non-core values are kept as evidence; a core identity/content collision stops.
Session rows differ: a session keeps growing on the machine that owns it (ended_at, title,
usage), and only rows of their own machine ever arrive, so a non-NULL incoming value wins —
the same rule export.ts applies to its own sessions (insSess in db.ts).

    sessions_sync.py export --since MS          stream own rows to stdout (MS < 0: everything)
    sessions_sync.py import                     apply a stream from stdin, print a JSON summary
    sessions_sync.py serve                      forced-command entry: export|import only
    sessions_sync.py run [--peer NAME]          driver: pull/push per ~/.config/agent-sessions/sync.json

Machine name and DB path come from ~/.config/agent-sessions/config.json (`machine`, `db_path`),
the same file the exporter reads.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import time

SESS = "session_id machine cli project cwd title started_at ended_at model model_provider parent_session_id usage meta".split()
MSGS = "id content_hash session_id seq role model ts parent_id text extra heavy updated_at".split()
TEXT = set("session_id machine cli project cwd title model model_provider parent_session_id usage meta "
           "id content_hash role parent_id text extra".split())
INDEXED = (b"user", b"assistant")
MARGIN_MS = 120_000        # resend the last two minutes: rows of a still-open writer transaction
BATCH = 1000
RESERVE = 768 * 1024 ** 2  # stop before the DB filesystem drops below this
CONFIG = Path(os.environ.get("AGENT_SESSIONS_CONFIG", "~/.config/agent-sessions/config.json")).expanduser()
SYNC_CONFIG = Path(os.environ.get("AGENT_SESSIONS_SYNC_CONFIG", "~/.config/agent-sessions/sync.json")).expanduser()


class SyncError(Exception):
    pass


def load_config():
    cfg = json.loads(CONFIG.read_text())
    machine = cfg.get("machine")
    if not machine or not isinstance(machine, str):
        raise SyncError(f"no 'machine' in {CONFIG}")
    db = Path(cfg.get("db_path") or "~/.cache/agent-sessions/sessions.db").expanduser()
    return machine, db


def connect(path, write=False):
    c = sqlite3.connect(str(path) if write else f"file:{path}?mode=ro", uri=not write, timeout=30)
    c.text_factory = bytes
    c.execute("pragma busy_timeout=30000")
    return c


def enc(v):
    return {"bytes": base64.b64encode(v).decode("ascii")} if isinstance(v, bytes) else v


def dec(v):
    return base64.b64decode(v["bytes"], validate=True) if isinstance(v, dict) else v


def wire(kind, row):
    return (json.dumps([kind, [enc(x) for x in row]], separators=(",", ":")) + "\n").encode()


def say(message):
    print(f"sessions-sync: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- export

def export(db, machine, since, out=sys.stdout.buffer):
    """Own-machine rows with coalesce(updated_at, 0) > since, in one read snapshot."""
    with contextlib.closing(connect(db)) as c:
        return _export(c, machine, since, out)


def _export(c, machine, since, out):
    c.execute("begin")  # one snapshot for sessions and messages
    h = hashlib.sha256()
    stats = {"machine": machine, "since": since, "sessions": 0, "messages": 0, "max_updated_at": since}
    # `m.updated_at > ?` (not coalesce) so the incremental path uses idx_msg_upd; rows with a NULL
    # updated_at predate the column and travel only in a full export (since < 0).
    sessions = ("select " + ",".join("s." + x for x in SESS) + " from sessions s where s.machine = ?"
                + ("" if since < 0 else " and s.session_id in (select distinct m.session_id from messages m"
                                       " indexed by idx_msg_upd where m.updated_at > ?)"))
    for row in c.execute(sessions, (machine,) if since < 0 else (machine, since)):
        b = wire("session", row); out.write(b); h.update(b); stats["sessions"] += 1
    messages = ("select " + ",".join("m." + x for x in MSGS) + " from messages m join sessions s"
                " on s.session_id = m.session_id where s.machine = ?"
                + ("" if since < 0 else " and m.updated_at > ?"))
    for row in c.execute(messages, (machine,) if since < 0 else (machine, since)):
        b = wire("message", row); out.write(b); h.update(b); stats["messages"] += 1
        if row[-1] is not None and row[-1] > stats["max_updated_at"]:
            stats["max_updated_at"] = row[-1]
    stats["sha256"] = h.hexdigest()
    out.write((json.dumps(["end", stats]) + "\n").encode())
    out.flush()
    c.rollback()
    return stats


# ---------------------------------------------------------------- import

def add_missing_json(local, remote):
    if local is None: return remote
    if remote is None or local == remote: return local
    try: a, b = json.loads(local), json.loads(remote)
    except (ValueError, UnicodeDecodeError): return local
    if not isinstance(a, dict) or not isinstance(b, dict): return local
    def merge(a, b):
        z = dict(a)
        for k, v in b.items():
            if k not in z or z[k] is None: z[k] = v
            elif isinstance(z[k], dict) and isinstance(v, dict): z[k] = merge(z[k], v)
        return z
    z = merge(a, b)
    return json.dumps(z, ensure_ascii=True, separators=(",", ":")).encode() if z != a else local


def placeholders(cols):
    return ",".join("cast(? as text)" if x in TEXT else "?" for x in cols)


def role_variant(local, source):
    return local[4] == b"agent" and source[4] == b"assistant" and all(local[i] == source[i] for i in (0, 1, 2, 3, 8))


def import_stream(db, stream, own_machine, evidence_dir=None, reserve=RESERVE):
    with contextlib.closing(connect(db, write=True)) as c:
        try:
            return _import(c, db, stream, own_machine, evidence_dir, reserve)
        except BaseException:
            if c.in_transaction:
                c.rollback()   # batches already committed are valid and idempotent
            raise


def _import(c, db, stream, own_machine, evidence_dir, reserve):
    c.execute("pragma journal_mode=wal")
    st = {"sessions_new": 0, "sessions_enriched": 0, "sessions_updated": 0, "messages_new": 0, "messages_enriched": 0,
          "messages_existing": 0, "fts_added": 0, "conflicts": 0, "role_variants": 0}
    h = hashlib.sha256(); seen = {"session": 0, "message": 0}; footer = None
    conflicts = []
    c.execute("begin immediate")
    for line in stream:
        kind, payload = json.loads(line)
        if kind == "end":
            if footer is not None: raise SyncError("duplicate footer")
            footer = payload; continue
        if footer is not None: raise SyncError("data after footer")
        if kind not in seen: raise SyncError(f"unknown record kind {kind!r}")
        h.update(line); seen[kind] += 1
        row = [dec(v) for v in payload]
        cols, table, key = (SESS, "sessions", "session_id") if kind == "session" else (MSGS, "messages", "id")
        if kind == "session" and row[1] == own_machine.encode():
            raise SyncError("stream carries rows of this machine; refusing to loop them back")
        old = c.execute(f"select {','.join(cols)} from {table} where {key}=?", (row[0].decode(),)).fetchone()
        if old is None:
            cur = c.execute(f"insert into {table}({','.join(cols)}) values ({placeholders(cols)})", row)
            if kind == "session":
                st["sessions_new"] += 1
            else:
                st["messages_new"] += 1
                if row[4] in INDEXED:
                    c.execute("insert into messages_fts(rowid,text) values (?,cast(? as text))", (cur.lastrowid, row[8]))
                    st["fts_added"] += 1
        else:
            if kind == "session":
                if old[1] != row[1] or (old[2] != row[2] and {old[2], row[2]} != {b"cursor", b"cursor-chats"}):
                    raise SyncError("session identity collision: " + row[0].decode())
            else:
                st["messages_existing"] += 1
                core = [cols[i] for i in (0, 1, 2, 3, 4, 8) if old[i] != row[i]]
                if core == ["role"] and role_variant(old, row):
                    st["role_variants"] += 1; core = []
                if core:
                    raise SyncError(f"message identity/content collision: {row[0].decode()} ({','.join(core)})")
            new, differing = list(old), False
            if kind == "session":
                # The owner's newer values win; a NULL from the owner never erases a known value.
                new = [row[i] if row[i] is not None else old[i] for i in range(len(cols))]
                if new != list(old):
                    st["sessions_updated"] += 1
                    fields = ",".join(f"{x}=" + ("cast(? as text)" if x in TEXT else "?") for x in cols[1:])
                    c.execute(f"update {table} set {fields} where {key}=?", new[1:] + [row[0].decode()])
                continue
            for i, col in enumerate(cols):
                if col == "updated_at": continue
                if col in ("extra", "meta", "usage"):
                    new[i] = add_missing_json(old[i], row[i])
                    if old[i] is not None and row[i] is not None and old[i] != row[i]: differing = True
                elif old[i] is None:
                    new[i] = row[i]
                elif row[i] is not None and old[i] != row[i]:
                    differing = True
            if differing:
                st["conflicts"] += 1
                conflicts.append(line)
            if new != list(old):
                st["sessions_enriched" if kind == "session" else "messages_enriched"] += 1
                if kind == "message": new[-1] = int(time.time() * 1000)
                fields = ",".join(f"{x}=" + ("cast(? as text)" if x in TEXT else "?") for x in cols[1:])
                c.execute(f"update {table} set {fields} where {key}=?", new[1:] + [row[0].decode()])
        if seen["message"] and seen["message"] % BATCH == 0:
            c.commit()
            free = os.statvfs(str(Path(db).parent))
            if free.f_bavail * free.f_frsize < reserve: raise SyncError("disk reserve breached")
            c.execute("begin immediate")
    if footer is None or footer["sha256"] != h.hexdigest() or seen != {"session": footer["sessions"], "message": footer["messages"]}:
        raise SyncError("incomplete or corrupt stream (the batches already committed are valid and idempotent)")
    c.commit()
    if conflicts and evidence_dir:
        evidence_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = evidence_dir / f"conflicts-{footer['machine']}-{int(time.time())}.jsonl.gz"
        with gzip.open(path, "xb") as f:
            for line in conflicts: f.write(line)
        st["conflicts_evidence"] = str(path)
    st["source"] = {k: footer[k] for k in ("machine", "since", "sessions", "messages", "max_updated_at")}
    return st


# ---------------------------------------------------------------- cursors + driver

def get_state(db, key):
    c = connect(db, write=True)
    c.execute("create table if not exists export_state (key text primary key, value text)")
    row = c.execute("select value from export_state where key=?", (key,)).fetchone()
    c.close()
    return int(row[0]) if row else -1


def set_state(db, key, value):
    with contextlib.closing(connect(db, write=True)) as c:
        _set_state(c, key, value)


def _set_state(c, key, value):
    c.execute("insert into export_state(key,value) values(?,?) on conflict(key) do update set value=excluded.value",
              (key, str(value)))
    c.commit()


def next_cursor(max_updated_at, previous):
    return max(previous, max_updated_at - MARGIN_MS) if max_updated_at >= 0 else previous


def run(peer_names=None):
    machine, db = load_config()
    peers = json.loads(SYNC_CONFIG.read_text())["peers"]
    state_dir = Path("~/.local/state/agent-sessions/sync").expanduser()
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    results = {}
    with open(state_dir / "lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError("another sessions-sync run is in progress")
        for p in peers:
            name, direction, remote_machine = p["name"], p["direction"], p["machine"]
            if peer_names and name not in peer_names: continue
            if direction not in ("both", "pull", "push"): raise SyncError(f"{name}: bad direction {direction!r}")
            ssh = list(p["ssh"])
            res = results[name] = {}
            if direction in ("both", "pull"):
                key = f"sync:pulled:{remote_machine}"
                since = get_state(db, key)
                say(f"{name}: pulling {remote_machine} rows newer than {since}…")
                proc = subprocess.Popen(ssh + [f"export --since {since}"], stdout=subprocess.PIPE)
                try:
                    st = import_stream(db, proc.stdout, machine, state_dir / "evidence")
                except BaseException:
                    proc.kill()   # a remote writer blocked on a full pipe would otherwise hang wait()
                    raise
                finally:
                    proc.stdout.close()
                    rc = proc.wait()
                if rc: raise SyncError(f"{name}: remote export exited {rc}")
                if st["source"]["machine"] != remote_machine:
                    raise SyncError(f"{name}: remote says it is {st['source']['machine']!r}, expected {remote_machine!r}")
                set_state(db, key, next_cursor(st["source"]["max_updated_at"], since))
                res["pulled"] = st
                say(f"{name}: pulled {st['messages_new']} new messages, {st['sessions_new']} new sessions")
            if direction in ("both", "push"):
                key = f"sync:pushed:{remote_machine}"
                since = get_state(db, key)
                say(f"{name}: pushing {machine} rows newer than {since}…")
                proc = subprocess.Popen(ssh + ["import"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                try:
                    sent = export(db, machine, since, proc.stdin)
                    proc.stdin.close()
                    out = proc.stdout.read()
                finally:
                    proc.stdout.close()
                    rc = proc.wait()
                if rc: raise SyncError(f"{name}: remote import exited {rc}: {out[-500:].decode(errors='replace')}")
                st = json.loads(out.decode().strip().splitlines()[-1])
                if st["source"]["max_updated_at"] != sent["max_updated_at"]:
                    raise SyncError(f"{name}: remote applied a different stream")
                set_state(db, key, next_cursor(sent["max_updated_at"], since))
                res["pushed"] = st
                say(f"{name}: pushed {sent['messages']} messages ({st['messages_new']} new there)")
    return results


def serve():
    """Forced-command entry (authorized_keys command=…): only export/import, nothing else."""
    words = shlex.split(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    machine, db = load_config()
    if len(words) == 3 and words[:2] == ["export", "--since"] and words[2].lstrip("-").isdigit():
        export(db, machine, int(words[2]))
    elif words == ["import"]:
        st = import_stream(db, sys.stdin.buffer, machine,
                           Path("~/.local/state/agent-sessions/sync/evidence").expanduser())
        print(json.dumps(st), flush=True)
    else:
        raise SyncError("only 'export --since <ms>' and 'import' are allowed")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export"); e.add_argument("--since", type=int, required=True)
    sub.add_parser("import")
    sub.add_parser("serve")
    r = sub.add_parser("run"); r.add_argument("--peer", action="append")
    a = p.parse_args(argv)
    try:
        if a.cmd == "export":
            machine, db = load_config(); export(db, machine, a.since)
        elif a.cmd == "import":
            machine, db = load_config()
            print(json.dumps(import_stream(db, sys.stdin.buffer, machine,
                                           Path("~/.local/state/agent-sessions/sync/evidence").expanduser())))
        elif a.cmd == "serve":
            serve()
        else:
            print(json.dumps(run(a.peer), ensure_ascii=False))
        return 0
    except (SyncError, sqlite3.Error, OSError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "needs_attention", "reason": type(exc).__name__, "detail": str(exc)[:500]}),
              file=sys.stderr if a.cmd in ("export",) else sys.stdout)
        return 2


if __name__ == "__main__":
    sys.exit(main())
