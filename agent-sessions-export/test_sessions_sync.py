#!/usr/bin/env python3
import contextlib
import gzip
import io
import json
import os
from pathlib import Path
import select
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import sessions_sync as ss

SCRIPT = Path(__file__).with_name("sessions_sync.py")
DB_TS = Path(__file__).with_name("db.ts")
BUN = shutil.which("bun")

SCHEMA = """
CREATE TABLE IF NOT EXISTS export_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, machine TEXT, cli TEXT, project TEXT, cwd TEXT,
  title TEXT, started_at INTEGER, ended_at INTEGER, model TEXT, model_provider TEXT, parent_session_id TEXT,
  usage TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, session_id TEXT, seq INTEGER,
  role TEXT, model TEXT, ts INTEGER, parent_id TEXT, text TEXT NOT NULL, extra TEXT, heavy BLOB, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_msg_upd ON messages(updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram');
"""


def make_db(path):
    c = sqlite3.connect(path); c.executescript(SCHEMA); c.commit(); c.close()


def add(path, machine, sid, msgs, title="t"):
    c = sqlite3.connect(path)
    c.execute("insert or ignore into sessions(session_id,machine,cli,project,title) values(?,?,?,?,?)",
              (sid, machine, "claude_code", "p", title))
    for mid, role, text, upd, heavy in msgs:
        cur = c.execute("insert into messages(id,content_hash,session_id,seq,role,text,heavy,updated_at)"
                        " values(?,?,?,?,?,?,?,?)", (mid, "h" + mid, sid, 0, role, text, heavy, upd))
        if role in ("user", "assistant"):
            c.execute("insert into messages_fts(rowid,text) values(?,?)", (cur.lastrowid, text))
    c.commit(); c.close()


def search(path, term):
    with contextlib.closing(sqlite3.connect(path)) as c:
        return [r[0] for r in c.execute("select m.id from messages_fts f join messages m on m.rowid=f.rowid"
                                    " where messages_fts match ?", (term,))]


def count(path, table):
    c = sqlite3.connect(path); n = c.execute(f"select count(*) from {table}").fetchone()[0]; c.close(); return n


def stream(path, machine, since):
    out = io.BytesIO(); st = ss.export(path, machine, since, out); out.seek(0); return out, st


class SessionsSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sessions-sync-"); self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name)
        self.a, self.b = self.d / "a.db", self.d / "b.db"
        make_db(self.a); make_db(self.b)
        add(self.a, "alpha", "s1", [("m1", "user", "hello alpha world", 1000, None),
                                    ("m2", "assistant", "answer from alpha", 2000, b"\x00\xffheavy"),
                                    ("m3", "tool", "tool output alphatool", 3000, None),
                                    ("m4", "user", "legacy row before updated_at", None, None)])
        add(self.b, "beta", "s9", [("b1", "user", "beta local note", 5000, None)])

    def conn(self, path):
        c = sqlite3.connect(path)
        self.addCleanup(c.close)
        return c

    @unittest.skipUnless(BUN and Path("/usr/bin/flock").is_file(), "Bun and flock are required")
    def test_writer_lock_matches_bun_through_symlinks(self):
        for db in (self.a, self.d / "new.db"):
            with self.subTest(db=db.name):
                alias = db.with_suffix(".alias")
                alias.symlink_to(db.name)
                script = f"""
import {{ acquireWriterLock }} from {json.dumps(str(DB_TS.resolve()))};
import {{ readSync }} from "node:fs";
acquireWriterLock({json.dumps(str(alias))});
console.log("locked");
readSync(0, Buffer.alloc(1), 0, 1);
process.exit(7);
"""
                with subprocess.Popen([BUN, "--eval", script], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE) as proc:
                    try:
                        self.assertTrue(select.select([proc.stdout], [], [], 30)[0])
                        self.assertEqual(proc.stdout.readline(), b"locked\n")
                        native_flock = ss.fcntl.flock
                        with mock.patch.object(ss.fcntl, "flock", side_effect=lambda file, op:
                                               native_flock(file, op | ss.fcntl.LOCK_NB)):
                            with self.assertRaises(BlockingIOError):
                                with ss.writer_lock(db):
                                    self.fail("Python acquired the lock while Bun held it")
                            with ss.writer_lock(self.b):
                                pass
                        proc.stdin.close()
                        self.assertEqual(proc.wait(timeout=30), 7)
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait(timeout=30)
                with ss.writer_lock(db):
                    pass

    def test_import_waits_for_first_record_before_writer_lock(self):
        out, _ = stream(self.a, "alpha", -1)
        lock = Path(f"{self.b}.writer.lock")

        def records():
            self.assertFalse(lock.exists(), "writer lock acquired before input arrived")
            yield next(out)
            self.assertTrue(lock.exists())
            yield from out

        stats = ss.import_stream(self.b, records(), "beta")
        self.assertEqual(stats["messages_new"], 4)

    def test_round_trip_full_fts_and_bytes(self):
        out, st = stream(self.a, "alpha", -1)
        self.assertEqual((st["sessions"], st["messages"], st["max_updated_at"]), (1, 4, 3000))
        r = ss.import_stream(self.b, out, "beta")
        self.assertEqual((r["messages_new"], r["sessions_new"], r["fts_added"]), (4, 1, 3))
        self.assertEqual(search(self.b, "alpha world"), ["m1"])
        self.assertEqual(search(self.b, "alphatool"), [], "tool roles are stored but not indexed")
        c = self.conn(self.b)
        self.assertEqual(c.execute("select heavy from messages where id='m2'").fetchone()[0], b"\x00\xffheavy")
        self.assertEqual(c.execute("select machine from sessions where session_id='s1'").fetchone()[0], "alpha")

    def test_repeat_is_idempotent_and_incremental_since(self):
        out, _ = stream(self.a, "alpha", -1); ss.import_stream(self.b, out, "beta")
        out, _ = stream(self.a, "alpha", -1); r = ss.import_stream(self.b, out, "beta")
        self.assertEqual((r["messages_new"], r["messages_enriched"], r["fts_added"]), (0, 0, 0))
        _, st = stream(self.a, "alpha", 1500)
        self.assertEqual(st["messages"], 2, "only rows newer than the cursor; NULL updated_at only on full export")

    def test_no_echo_and_refuses_own_rows(self):
        out, _ = stream(self.a, "alpha", -1); ss.import_stream(self.b, out, "beta")
        _, st = stream(self.b, "beta", -1)
        self.assertEqual((st["sessions"], st["messages"]), (1, 1), "B exports only its own machine")
        out, _ = stream(self.a, "alpha", -1)
        with self.assertRaises(ss.SyncError):
            ss.import_stream(self.a, out, "alpha")

    def test_enrichment_fills_nulls_never_overwrites_and_keeps_conflicts(self):
        out, _ = stream(self.a, "alpha", -1); ss.import_stream(self.b, out, "beta")
        c = self.conn(self.b)   # local value on B that A later disagrees with
        c.execute("update messages set model='local-model' where id='m1'"); c.commit(); c.close()
        c = self.conn(self.a)
        c.execute("update messages set model='remote-model', parent_id='p0', updated_at=9000 where id='m1'")
        c.execute("update messages set extra=?, updated_at=9000 where id='m3'", (json.dumps({"k": 1}),))
        c.commit(); c.close()
        out, _ = stream(self.a, "alpha", 3000)
        r = ss.import_stream(self.b, out, "beta", self.d / "evidence")
        c = self.conn(self.b)
        self.assertEqual(c.execute("select model, parent_id from messages where id='m1'").fetchone(), ("local-model", "p0"))
        self.assertEqual(json.loads(c.execute("select extra from messages where id='m3'").fetchone()[0]), {"k": 1})
        self.assertEqual(r["conflicts"], 1)
        with gzip.open(r["conflicts_evidence"]) as f:
            kind, row = json.loads(f.readline())
        self.assertEqual(ss.dec(row[5]), b"remote-model", "the differing remote value is kept as evidence")

    def test_session_rows_follow_their_owner_but_null_never_erases(self):
        """A session keeps growing where it runs: newer ended_at/title/usage arrive; NULL does not erase."""
        out, _ = stream(self.a, "alpha", -1); ss.import_stream(self.b, out, "beta")
        c = self.conn(self.a)
        c.execute("update sessions set ended_at=77, title='longer title', usage='{\"t\":2}', cwd=NULL where session_id='s1'")
        c.execute("update messages set updated_at=9500 where id='m1'")   # the session has news
        c.commit()
        cb = self.conn(self.b)
        cb.execute("update sessions set cwd='/known/cwd' where session_id='s1'"); cb.commit()
        out, _ = stream(self.a, "alpha", 3000)
        r = ss.import_stream(self.b, out, "beta", self.d / "evidence")
        self.assertEqual(r["sessions_updated"], 1)
        self.assertEqual(r["conflicts"], 0, "session growth is not a conflict")
        row = cb.execute("select ended_at, title, usage, cwd from sessions where session_id='s1'").fetchone()
        self.assertEqual(row, (77, "longer title", '{"t":2}', "/known/cwd"))

    def test_content_collision_stops(self):
        out, _ = stream(self.a, "alpha", -1); ss.import_stream(self.b, out, "beta")
        c = self.conn(self.a); c.execute("update messages set text='changed', updated_at=9999 where id='m1'"); c.commit(); c.close()
        out, _ = stream(self.a, "alpha", 3000)
        with self.assertRaisesRegex(ss.SyncError, "collision"):
            ss.import_stream(self.b, out, "beta")

    def test_truncated_stream_fails(self):
        out, _ = stream(self.a, "alpha", -1)
        lines = out.getvalue().splitlines(keepends=True)[:-1]   # drop the footer
        with self.assertRaisesRegex(ss.SyncError, "incomplete"):
            ss.import_stream(self.b, io.BytesIO(b"".join(lines)), "beta")

    def test_serve_allows_only_export_and_import(self):
        cfg = self.d / "cfg.json"; cfg.write_text(json.dumps({"machine": "alpha", "db_path": str(self.a)}))
        env = {**os.environ, "AGENT_SESSIONS_CONFIG": str(cfg), "HOME": str(self.d)}
        for bad in ["rm -rf /", "export --since 1; id", "export", "sh"]:
            r = subprocess.run([sys.executable, str(SCRIPT), "serve"], env={**env, "SSH_ORIGINAL_COMMAND": bad},
                               capture_output=True, timeout=60)
            self.assertEqual(r.returncode, 2, bad)
        r = subprocess.run([sys.executable, str(SCRIPT), "serve"], env={**env, "SSH_ORIGINAL_COMMAND": "export --since -1"},
                           capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(b'"end"', r.stdout.splitlines()[-1])

    def run_peer(self, direction):
        """Driver on A against B, with ssh replaced by a local serve under B's config."""
        cfg_a, cfg_b = self.d / "cfg-a.json", self.d / "cfg-b.json"
        cfg_a.write_text(json.dumps({"machine": "alpha", "db_path": str(self.a)}))
        cfg_b.write_text(json.dumps({"machine": "beta", "db_path": str(self.b)}))
        wrapper = self.d / "fake-ssh"
        wrapper.write_text(f"#!/bin/sh\nSSH_ORIGINAL_COMMAND=\"$1\" AGENT_SESSIONS_CONFIG={cfg_b} HOME={self.d}/remote-home "
                           f"exec {sys.executable} {SCRIPT} serve\n")
        wrapper.chmod(0o755)
        sync = self.d / "sync.json"
        sync.write_text(json.dumps({"peers": [{"name": "b", "machine": "beta", "direction": direction, "ssh": [str(wrapper)]}]}))
        with mock.patch.object(ss, "CONFIG", cfg_a), mock.patch.object(ss, "SYNC_CONFIG", sync), \
             mock.patch.dict(os.environ, {"HOME": str(self.d / "local-home")}):
            return ss.run()

    def test_run_both_directions_and_cursors(self):
        res = self.run_peer("both")["b"]
        self.assertEqual(res["pulled"]["messages_new"], 1)
        self.assertEqual(res["pushed"]["messages_new"], 4)
        self.assertEqual(search(self.a, "beta local"), ["b1"])
        self.assertEqual(search(self.b, "alpha world"), ["m1"])
        self.assertEqual(ss.get_state(self.a, "sync:pulled:beta"), 5000 - ss.MARGIN_MS if 5000 - ss.MARGIN_MS > -1 else -1)
        again = self.run_peer("both")["b"]
        self.assertEqual((again["pulled"]["messages_new"], again["pushed"]["messages_new"]), (0, 0))

    def test_run_pull_only_never_writes_remote(self):
        before = (count(self.b, "messages"), count(self.b, "sessions"))
        res = self.run_peer("pull")["b"]
        self.assertNotIn("pushed", res)
        self.assertEqual((count(self.b, "messages"), count(self.b, "sessions")), before)
        self.assertEqual(search(self.a, "beta local"), ["b1"])

    def test_run_push_only(self):
        res = self.run_peer("push")["b"]
        self.assertNotIn("pulled", res)
        self.assertEqual(search(self.a, "beta local"), [])
        self.assertEqual(search(self.b, "alpha world"), ["m1"])

    def test_schema_columns_match_db_ts(self):
        src = DB_TS.read_text()
        for col in ss.SESS + ss.MSGS:
            self.assertIn(col, src, f"column {col} not in db.ts")


if __name__ == "__main__":
    unittest.main()
