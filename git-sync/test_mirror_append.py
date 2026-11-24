#!/usr/bin/env python3
"""mirror and append modes, on throwaway repositories (no knowledge layout needed)."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from git_sync import Append, Config, Mirror, Stop, execute, git, oid

SCRIPT = Path(__file__).with_name("git_sync.py")
GUARD = Path(__file__).with_name("live-tree-guard.sh")


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="git-sync-modes-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.remote, self.live, self.other = (self.base / x for x in ("remote.git", "live", "other"))
        execute(["git", "init", "--bare", "--initial-branch=main", str(self.remote)])
        execute(["git", "clone", str(self.remote), str(self.live)])
        self.configure(self.live)
        self.write(self.live, "README.md", b"readme\n")
        self.write(self.live, "CHANGELOG.jsonl", b'{"n": 0}\n')
        self.commit(self.live, ["README.md", "CHANGELOG.jsonl"], "init")
        git(self.live, "push", "origin", "main")
        execute(["git", "clone", str(self.remote), str(self.other)])
        self.configure(self.other)
        self.pending = self.base / "pending" / "changelog.jsonl"
        self.pending.parent.mkdir()

    def configure(self, repo):
        git(repo, "config", "user.name", "Fixture")
        git(repo, "config", "user.email", "fixture@example.invalid")
        hooks = repo.parent / (repo.name + "-hooks")
        hooks.mkdir(exist_ok=True)
        git(repo, "config", "core.hooksPath", str(hooks))

    def write(self, repo, name, data):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def commit(self, repo, paths, message="change"):
        git(repo, "add", "--", *paths)
        git(repo, "commit", "-m", message)

    def push_other(self, name, data, message="remote change"):
        git(self.other, "pull", "--ff-only")
        self.write(self.other, name, data)
        self.commit(self.other, [name], message)
        git(self.other, "push", "origin", "main")
        return oid(self.other)

    def config(self, mode, **extra):
        values = dict(repo=self.live, remote="origin", remote_url=str(self.remote), branch="main",
                      device="server", state_dir=self.base / "state", commit_message="log: {count} lines",
                      mode=mode, quiet_seconds=0)
        if mode == "append":
            values.update(pending=str(self.pending), target="CHANGELOG.jsonl", json_lines=True)
        values.update(extra)
        return Config(**values)

    def stop(self, runner, reason):
        with self.assertRaises(Stop) as caught:
            runner.run()
        self.assertEqual(caught.exception.result["reason"], reason, caught.exception.result)
        return caught.exception.result


class MirrorTest(Fixture):
    def test_up_to_date_then_fast_forward(self):
        self.assertEqual(Mirror(self.config("mirror")).run()["status"], "up_to_date")
        remote = self.push_other("README.md", b"new readme\n")
        result = Mirror(self.config("mirror")).run()
        self.assertEqual(result["status"], "updated")
        self.assertEqual(result["pulled_commits"], 1)
        self.assertEqual(oid(self.live), remote)
        self.assertEqual((self.live / "README.md").read_bytes(), b"new readme\n")

    def test_untracked_files_do_not_block(self):
        self.write(self.live, "scratch/notes.txt", b"local only\n")
        remote = self.push_other("README.md", b"new readme\n")
        self.assertEqual(Mirror(self.config("mirror")).run()["status"], "updated")
        self.assertEqual(oid(self.live), remote)
        self.assertTrue((self.live / "scratch/notes.txt").is_file())

    def test_dirty_tree_is_reported_and_left_alone(self):
        before = oid(self.live)
        self.write(self.live, "CHANGELOG.jsonl", b'{"n": 0}\n{"n": 1}\n')
        self.push_other("README.md", b"new readme\n")
        result = self.stop(Mirror(self.config("mirror")), "dirty")
        self.assertEqual(result["behind"], 1)
        self.assertEqual(result["changes"], [{"path": "CHANGELOG.jsonl", "on_remote": True,
                                              "same_as_remote": False, "lines_only_local": 1}])
        self.assertEqual(oid(self.live), before)
        self.assertEqual((self.live / "CHANGELOG.jsonl").read_bytes(), b'{"n": 0}\n{"n": 1}\n')

    def test_diverged_reports_commits_missing_from_remote(self):
        # The same change pushed from elsewhere (equal patch) and one change that exists only here.
        self.push_other("README.md", b"shared\n")
        self.write(self.live, "README.md", b"shared\n")
        self.commit(self.live, ["README.md"], "same patch")
        self.write(self.live, "local.txt", b"only here\n")
        self.commit(self.live, ["local.txt"], "unique")
        result = self.stop(Mirror(self.config("mirror")), "diverged")
        self.assertEqual(result["ahead"], 2)
        self.assertEqual(result["not_on_remote_by_patch"], [oid(self.live)])

    def test_status_and_plan_are_read_only(self):
        self.write(self.live, "README.md", b"edited\n")
        run = subprocess.run([sys.executable, str(SCRIPT), "plan", "--config", str(self.profile("mirror"))],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result["status"], "dirty")
        self.assertFalse(result["network_checked"])
        self.assertEqual(result["actions"], ["fetch", "fast_forward_only_if_clean"])
        self.assertFalse((self.base / "state").exists(), "read-only commands create no state")

    def profile(self, mode):
        path = self.base / f"{mode}.json"
        data = {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(self.config(mode)).items()}
        path.write_text(json.dumps(data))
        return path


class AppendTest(Fixture):
    def remote_log(self):
        return git(self.remote, "show", "main:CHANGELOG.jsonl")

    def test_pending_lines_reach_the_remote_without_touching_the_tree(self):
        self.pending.write_bytes(b'{"n": 1}\n{"n": 2}\n')
        before = oid(self.live)
        result = Append(self.config("append")).run()
        self.assertEqual(result["status"], "pushed")
        self.assertEqual(result["lines"], 2)
        self.assertEqual(self.remote_log(), b'{"n": 0}\n{"n": 1}\n{"n": 2}\n')
        self.assertEqual(git(self.remote, "log", "-1", "--format=%s", "main").strip(), b"log: 2 lines")
        self.assertFalse(self.pending.exists())
        self.assertEqual(oid(self.live), before, "the local tree is never moved")
        self.assertEqual(git(self.live, "status", "--porcelain"), b"")
        self.assertEqual(Append(self.config("append")).run()["status"], "nothing_pending")

    def test_lines_already_on_the_remote_are_not_duplicated(self):
        self.push_other("CHANGELOG.jsonl", b'{"n": 0}\n{"n": 1}\n')
        self.pending.write_bytes(b'{"n": 1}\n{"n": 2}\n')
        result = Append(self.config("append")).run()
        self.assertEqual((result["lines"], result["skipped_present"]), (1, 1))
        self.assertEqual(self.remote_log(), b'{"n": 0}\n{"n": 1}\n{"n": 2}\n')

    def test_remote_moving_between_fetch_and_push_is_retried(self):
        fixture = self

        class Racing(Append):
            raced = False

            def fetch(self, attempt):
                remote = super().fetch(attempt)
                if not Racing.raced:
                    Racing.raced = True
                    fixture.push_other("README.md", b"raced\n")
                return remote

        self.pending.write_bytes(b'{"n": 1}\n')
        result = Racing(self.config("append")).run()
        self.assertEqual(result["status"], "pushed")
        self.assertEqual(self.remote_log(), b'{"n": 0}\n{"n": 1}\n')
        self.assertEqual(git(self.remote, "show", "main:README.md"), b"raced\n")

    def test_failed_push_keeps_the_batch_and_resumes_it_first(self):
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        self.pending.write_bytes(b'{"n": 1}\n')
        result = self.stop(Append(self.config("append", max_attempts=2)), "push_not_accepted")
        self.assertEqual(result["status"], "waiting_remote")
        self.assertFalse(self.pending.exists())
        self.pending.write_bytes(b'{"n": 2}\n')          # a writer goes on while the batch waits
        hook.unlink()
        first = Append(self.config("append")).run()
        self.assertEqual(first["lines"], 1)
        self.assertEqual(self.remote_log(), b'{"n": 0}\n{"n": 1}\n')
        second = Append(self.config("append")).run()
        self.assertEqual(second["lines"], 1)
        self.assertEqual(self.remote_log(), b'{"n": 0}\n{"n": 1}\n{"n": 2}\n')

    def test_invalid_json_line_stops_before_anything_is_pushed(self):
        self.pending.write_bytes(b'{"n": 1}\nnot json\n')
        result = self.stop(Append(self.config("append")), "invalid_json_line")
        self.assertEqual(result["line"], 2)
        self.assertEqual(self.remote_log(), b'{"n": 0}\n')

    def test_commit_hooks_run_in_the_private_worktree(self):
        hook = self.live.parent / "live-hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\necho refused >&2\nexit 1\n")
        hook.chmod(0o755)
        self.pending.write_bytes(b'{"n": 1}\n')
        result = self.stop(Append(self.config("append")), "commit_failed")
        self.assertIn(b"refused", Path(result["evidence"]).read_bytes())
        self.assertEqual(self.remote_log(), b'{"n": 0}\n')


class GuardTest(Fixture):
    def test_guard_blocks_the_main_tree_and_lets_append_through(self):
        hook = self.live.parent / "live-hooks" / "pre-commit"
        hook.write_text(f'#!/bin/sh\nexec "{GUARD}"\n')
        hook.chmod(0o755)
        git(self.live, "config", "gitsync.liveTree", "true")
        self.write(self.live, "README.md", b"edited in the live tree\n")
        git(self.live, "add", "--", "README.md")
        blocked = git(self.live, "commit", "-m", "nope", check=False)
        self.assertEqual(blocked.returncode, 1)
        self.assertIn(b"worktree", blocked.stderr)
        git(self.live, "reset", "-q", "--", "README.md")
        git(self.live, "checkout", "--", "README.md")
        self.pending.write_bytes(b'{"n": 1}\n')
        self.assertEqual(Append(self.config("append")).run()["status"], "pushed")


if __name__ == "__main__":
    unittest.main()
