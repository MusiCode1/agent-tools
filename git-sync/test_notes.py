"""Real Git fixtures only: two clones, a bare remote and the real content gate."""
import dataclasses
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

import yaml

from git_sync import Config, Sync, Stop, FRONTMATTER, execute, git, oid, subsequence


# notes mode needs a knowledge repository's validator and layout contract (agents-kb layout).
# Point GIT_SYNC_KB_REPO at a checkout that has them; otherwise these tests are skipped.
KB_REPO = os.environ.get("GIT_SYNC_KB_REPO", "")
INFRA = Path(KB_REPO).expanduser() / "agents/infra"
VALIDATOR = INFRA / "scripts/knowledge_tools.py"
SCRIPT = Path(__file__).with_name("git_sync.py")
if not (KB_REPO and VALIDATOR.is_file()):
    raise unittest.SkipTest("notes mode: set GIT_SYNC_KB_REPO to a knowledge repository checkout")


# Entity pages need an opening (knowledge_tools hygiene, enforced since 2026-11-11).
OPENING = ("# Entity\n\nA fixture entity page used by the sync tests. This opening satisfies the "
           "entity-page rule that requires a title line and a paragraph of at least 80 characters.\n\n")


def note(body="body\n", **fields):
    meta = {"title": "Note", "audience": ["human"], **fields}
    return b"---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).encode() + b"---\n" + body.encode()


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="knowledge-sync-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.remote, self.a, self.b = (self.base / x for x in ("remote.git", "phone", "computer"))
        execute(["git", "init", "--bare", "--initial-branch=main", str(self.remote)])
        execute(["git", "clone", str(self.remote), str(self.a)])
        self.configure(self.a)
        self.files = {
            "library/one.md": note("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"),
            "library/two.md": note("other\n"),
            "library/home.md": note("[Home](../home.md)\n"),
            "wiki/home.md": note("[Home](../home.md)\n", audience=["human", "agents"]),
            "home.md": note("[Wiki](wiki/home.md) [Library](library/home.md)\n"),
            "agents/rules/example.md": note("rule\n", audience=["agents"]),
            "agents/infra/config/knowledge-layout.json": (INFRA / "config/knowledge-layout.json").read_bytes(),
            ".obsidian/app.json": b"{}\n",
            "tool.py": b"print('fixture')\n",
        }
        for name, content in self.files.items():
            self.write(self.a, name, content)
        self.command_gate(self.a, "wiki-index")
        self.command_gate(self.a, "workflows-index")
        self.commit(self.a, list(self.files) + ["agents/infra/generated/wiki-entities.md", "agents/procedures/INDEX.md",
                                                 "agents/infra/generated/entity-workflows.md"])
        self.g(self.a, "push", "origin", "main")
        execute(["git", "clone", str(self.remote), str(self.b)])
        self.configure(self.b)
        self.config = Config(repo=self.a, remote="origin", remote_url=str(self.remote), branch="main",
                             device="phone", state_dir=self.base / "state", commit_message="fixture notes",
                             merge_message="fixture merge", exclusive_worktree=True, quiet_seconds=0,
                             validator=str(VALIDATOR))
        self.initial = oid(self.a)

    def g(self, repo, *args):
        return git(repo, *args)

    def configure(self, repo):
        self.g(repo, "config", "user.name", "Sync Fixture")
        self.g(repo, "config", "user.email", "fixture@example.invalid")
        hooks = repo.parent / (repo.name + "-hooks")
        hooks.mkdir()
        self.g(repo, "config", "core.hooksPath", str(hooks))

    def write(self, repo, path, data):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def commit(self, repo, paths):
        self.g(repo, "add", "--", *paths)
        self.g(repo, "commit", "-m", "fixture")

    def command_gate(self, repo, command):
        r = execute([sys.executable, str(VALIDATOR), command, "--root", str(repo)])
        self.assertEqual(r.returncode, 0, r.stderr.decode())

    def remote_change(self, path, content):
        self.g(self.b, "pull", "--ff-only")
        self.write(self.b, path, content)
        self.commit(self.b, [path])
        self.g(self.b, "push", "origin", "main")
        return oid(self.b)

    def sync(self, cls=Sync):
        return cls(self.config).sync(editor_paused=True)

    def fail(self, reason, cls=Sync):
        with self.assertRaises(Stop) as caught:
            self.sync(cls)
        self.assertEqual(caught.exception.result["reason"], reason, caught.exception.result)
        return caught.exception.result

    def test_local_edit_push_and_settings_preserved(self):
        content = note("ordinary replacement\n")
        self.write(self.a, "library/one.md", content)
        settings = self.write(self.a, ".obsidian/app.json", b'{"device":true}\n')
        result = self.sync()
        self.assertEqual(result["status"], "synced")
        self.assertEqual(self.g(self.remote, "show", "main:library/one.md"), content)
        self.assertEqual(settings.read_bytes(), b'{"device":true}\n')
        self.assertEqual(self.g(self.a, "diff", "--cached", "--name-only"), b"")
        self.assertEqual(self.g(self.a, "diff", "--name-only"), b".obsidian/app.json\n")
        self.assertEqual(self.g(self.a, "log", "-1", "--format=%s").strip(), b"fixture notes")

    def test_incoming_fast_forward_and_noop_create_no_commits(self):
        remote = self.remote_change("library/one.md", note("remote edit\n"))
        self.assertEqual(self.sync()["head"], remote)
        self.assertEqual(self.sync()["head"], remote)
        self.assertEqual(oid(self.remote, "main"), remote)

    def test_disjoint_additions_merge(self):
        original = self.files["library/one.md"]
        local = original.replace(b"two\n", b"two\nlocal addition\n")
        remote = original.replace(b"eight\n", b"eight\nremote addition\n")
        self.write(self.a, "library/one.md", local)
        self.remote_change("library/one.md", remote)
        result = self.sync()
        merged = (self.a / "library/one.md").read_bytes()
        self.assertEqual(result["copies"], [])
        self.assertTrue(subsequence(local, merged))
        self.assertTrue(subsequence(remote, merged))
        self.assertEqual(self.g(self.remote, "show", "main:library/one.md"), merged)

    def test_true_conflict_copy_preserves_raw_blob_and_body(self):
        local = note("phone version\n", permalink="active-note", inject="always", scope=["project:demo"])
        remote = note("computer version\n")
        self.write(self.a, "library/one.md", local)
        self.remote_change("library/one.md", remote)
        result = self.sync()
        self.assertEqual(result["status"], "copies_created")
        self.assertEqual((self.a / "library/one.md").read_bytes(), remote)
        self.assertEqual(len(result["copies"]), 1)
        copied = (self.a / result["copies"][0]).read_bytes()
        match = FRONTMATTER.match(copied)
        self.assertEqual(copied[match.end():], local[FRONTMATTER.match(local).end():])
        meta = yaml.safe_load(match.group(1))
        self.assertEqual(meta["lifecycle"], "history")
        for key in ("permalink", "scope", "inject"):
            self.assertNotIn(key, meta)
        self.assertEqual(self.g(self.a, "cat-file", "blob", meta["conflict_local_blob"]), local)
        journal = json.loads((Path(result["recovery"]) / "journal.json").read_text())
        self.assertEqual(self.g(self.a, "show", journal["ref_prefix"] + "/local:library/one.md"), local)
        self.assertEqual(self.sync()["copies"], [])
        self.g(self.b, "pull", "--ff-only")
        self.assertEqual((self.b / result["copies"][0]).read_bytes(), copied)

    def test_clean_git_merge_with_replacements_creates_copy(self):
        original = self.files["library/one.md"]
        local = original.replace(b"one\n", b"ONE\n")
        remote = original.replace(b"nine\n", b"NINE\n")
        self.write(self.a, "library/one.md", local)
        self.remote_change("library/one.md", remote)
        result = self.sync()
        self.assertEqual(len(result["copies"]), 1)
        self.assertEqual((self.a / "library/one.md").read_bytes(), remote)

    def test_identical_parallel_edits_need_no_copy(self):
        content = note("identical\n")
        self.write(self.a, "library/one.md", content)
        self.remote_change("library/one.md", content)
        self.assertEqual(self.sync()["copies"], [])

    def test_parallel_new_file_creates_copy(self):
        self.write(self.a, "library/new.md", note("left\n"))
        self.remote_change("library/new.md", note("right\n"))
        self.assertEqual(len(self.sync()["copies"]), 1)

    def test_unicode_literal_paths_crlf_and_missing_final_newline(self):
        name = "library/-\u05e4\u05ea\u05e7 [x]* with\ttab.md"
        original = note("first\nsecond").replace(b"\n", b"\r\n")
        self.write(self.a, name, original)
        self.sync()
        self.g(self.b, "pull", "--ff-only")
        local, remote = original + b" local", original + b" remote"
        self.write(self.a, name, local)
        self.remote_change(name, remote)
        result = self.sync()
        copied = (self.a / result["copies"][0]).read_bytes()
        self.assertEqual(copied[FRONTMATTER.match(copied).end():], local[FRONTMATTER.match(local).end():])
        self.assertEqual((self.a / name).read_bytes(), remote)

    def test_conflict_copy_collision_stops(self):
        local, remote = note("local\n"), note("remote\n")
        self.write(self.a, "library/one.md", local)
        self.remote_change("library/one.md", remote)
        left = git(self.a, "hash-object", "--stdin", data=local)
        right = git(self.a, "hash-object", "--stdin", data=remote)
        name, _ = Sync(self.config).conflict_copy("library/one.md", local, left.decode().strip(), right.decode().strip())
        collision = self.write(self.a, name, note("existing different content\n"))
        before = oid(self.remote, "main")
        self.fail("conflict_copy_collision")
        self.assertEqual(collision.read_bytes(), note("existing different content\n"))
        self.assertEqual(oid(self.remote, "main"), before)

    def test_wiki_copy_not_in_current_entities(self):
        path = "wiki/devices/example/example.md"
        seed = note(OPENING + "seed\n", audience=["human", "agents"], navigation_exclude="fixture")
        self.write(self.a, path, seed)
        self.sync()
        self.g(self.b, "pull", "--ff-only")
        self.write(self.a, path, seed.replace(b"seed", b"phone"))
        self.remote_change(path, seed.replace(b"seed", b"computer"))
        result = self.sync()
        self.assertEqual(len(result["copies"]), 1)
        self.assertNotIn(b"conflict", (self.a / "agents/infra/generated/wiki-entities.md").read_bytes())
        self.command_gate(self.a, "pre-commit")

    def test_stage_owned_by_another_actor_is_unchanged(self):
        self.write(self.a, "library/one.md", note("index unique\n"))
        self.g(self.a, "add", "--", "library/one.md")
        self.write(self.a, "library/one.md", note("worktree unique\n"))
        index = Sync(self.config).index_bytes()
        self.fail("staged_changes")
        self.assertEqual(Sync(self.config).index_bytes(), index)
        self.assertEqual(self.g(self.a, "show", ":library/one.md"), note("index unique\n"))
        self.assertEqual((self.a / "library/one.md").read_bytes(), note("worktree unique\n"))

    def test_git_operation_and_lock_not_removed(self):
        for filename in ("index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD"):
            path = self.a / ".git" / filename
            path.write_bytes(b"owned elsewhere")
            self.fail("git_operation_in_progress")
            self.assertEqual(path.read_bytes(), b"owned elsewhere")
            path.unlink()

    def test_protected_dirty_file_and_local_delete_stop(self):
        self.write(self.a, "tool.py", b"another agent\n")
        self.fail("protected_local_change")
        self.write(self.a, "tool.py", self.files["tool.py"])
        (self.a / "library/one.md").unlink()
        self.fail("unsupported_local_change")
        self.assertEqual(oid(self.a), self.initial)

    def test_committed_local_delete_and_modify_delete_conflict_stop(self):
        (self.a / "library/two.md").unlink()
        self.commit(self.a, ["library/two.md"])
        self.fail("local_deletion_or_rename")
        self.assertEqual(oid(self.remote, "main"), self.initial)

    def test_modify_delete_conflict_stops_after_local_commit(self):
        self.write(self.a, "library/one.md", note("local edit\n"))
        (self.b / "library/one.md").unlink()
        self.commit(self.b, ["library/one.md"])
        self.g(self.b, "push", "origin", "main")
        remote = oid(self.remote, "main")
        self.fail("structural_conflict")
        self.assertEqual(self.g(self.a, "show", "HEAD:library/one.md"), note("local edit\n"))
        self.assertEqual(oid(self.remote, "main"), remote)

    def test_symlink_and_binary_notes_stop(self):
        (self.a / "library/one.md").unlink()
        (self.a / "library/one.md").symlink_to(self.base / "outside")
        self.fail("unsupported_local_change")
        (self.a / "library/one.md").unlink()
        self.write(self.a, "library/one.md", b"binary\x00data")
        self.fail("binary_note")
        self.assertEqual(oid(self.a), self.initial)

    def test_offline_local_commit_then_reconnect(self):
        self.write(self.a, "library/one.md", note("offline edit\n"))
        offline = self.remote.with_name("temporarily-offline.git")
        self.remote.rename(offline)
        self.fail("fetch_failed")
        local = oid(self.a)
        self.assertNotEqual(local, self.initial)
        self.assertEqual(self.g(self.a, "show", "HEAD:library/one.md"), note("offline edit\n"))
        offline.rename(self.remote)
        self.assertEqual(self.sync()["status"], "synced")
        self.assertEqual(oid(self.remote, "main"), local)

    def test_missing_git_identity_stops_at_plan_not_mid_sync(self):
        """בלי זהות committer, ‏plan כבר אומר מה חסר, ו־sync לא משאיר stage באמצע."""
        self.write(self.a, "library/one.md", note("needs a commit\n"))
        self.g(self.a, "config", "--unset", "user.name")
        self.g(self.a, "config", "--unset", "user.email")
        self.g(self.a, "config", "user.useConfigOnly", "true")
        # execute() drops GIT_* variables, so global identity is isolated through HOME.
        home = self.base / "empty-home"
        home.mkdir()
        isolated = {"HOME": str(home), "XDG_CONFIG_HOME": str(home)}
        saved = {k: os.environ.get(k) for k in [*isolated, "EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
                                                 "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]}
        try:
            for k in saved:
                os.environ.pop(k, None)
            os.environ.update(isolated)
            with self.assertRaises(Stop) as caught:
                Sync(self.config).inspect()
            self.assertEqual(caught.exception.result["reason"], "missing_git_identity")
            self.fail("missing_git_identity")
            self.assertEqual(self.g(self.a, "diff", "--cached", "--name-only"), b"")
            self.assertEqual(oid(self.a), self.initial)
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            self.g(self.a, "config", "user.name", "Sync Fixture")
            self.g(self.a, "config", "user.email", "fixture@example.invalid")

    def test_progress_lines_on_stream_and_result_unchanged(self):
        import io
        self.write(self.a, "library/one.md", note("progress\n"))
        sync = Sync(self.config)
        sync.progress = io.StringIO()
        result = sync.sync(editor_paused=True)
        self.assertEqual(result["status"], "synced")
        lines = sync.progress.getvalue().splitlines()
        text = "\n".join(lines)
        for stage in ["בודק את העותק", "1 פתקים מקומיים", "pre-commit", "נשמר קומיט מקומי",
                      "מביא את main", "משלב", "העותק עודכן", "דוחף 1 קומיטים", "הסתיים"]:
            self.assertIn(stage, text)
        self.assertTrue(all(line.startswith("[") and "s] " in line for line in lines), lines)
        # Silent by default when used as a library; nothing is printed without a stream.
        quiet = Sync(self.config)
        self.assertIsNone(quiet.progress)

    def test_cli_progress_goes_to_stderr_and_json_to_stdout(self):
        self.write(self.a, "library/one.md", note("cli\n"))
        cfg = self.base / "profile.json"
        cfg.write_text(json.dumps({k: (str(v) if isinstance(v, Path) else v)
                                   for k, v in dataclasses.asdict(self.config).items()}))
        run = subprocess.run([sys.executable, str(SCRIPT), "sync", "--config", str(cfg), "--editor-paused"],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(json.loads(run.stdout)["status"], "synced", run.stderr)
        self.assertIn("הסתיים", run.stderr)
        run = subprocess.run([sys.executable, str(SCRIPT), "sync", "--config", str(cfg), "--editor-paused", "--quiet"],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(run.stderr, "")
        self.assertIn(json.loads(run.stdout)["status"], {"synced"})

    def test_readonly_plan_does_not_touch_index_refs_or_state(self):
        self.write(self.a, "library/one.md", note("dirty\n"))
        sync = Sync(self.config)
        index, refs, files = sync.index_bytes(), self.g(self.a, "show-ref"), sync.fingerprint()
        result = sync.inspect()
        self.assertEqual(result["files"], ["library/one.md"])
        self.assertEqual(sync.index_bytes(), index)
        self.assertEqual(self.g(self.a, "show-ref"), refs)
        self.assertEqual(sync.fingerprint(), files)
        self.assertFalse(self.config.state_dir.exists())

    def test_wrong_remote_and_missing_editor_ack_stop(self):
        with self.assertRaises(Stop) as caught:
            Sync(self.config).sync()
        self.assertEqual(caught.exception.result["reason"], "exclusive_paused_editor_required")
        self.g(self.a, "config", "remote.origin.pushurl", str(self.base / "wrong.git"))
        self.fail("remote_identity_changed")
        self.assertEqual(oid(self.a), self.initial)

    def test_concurrent_edit_before_apply_preserved(self):
        fixture = self
        self.remote_change("library/one.md", note("upstream\n"))
        class Writer(Sync):
            def checkpoint(self, phase, **values):
                super().checkpoint(phase, **values)
                if phase == "before_apply":
                    fixture.write(fixture.a, "library/one.md", note("new live edit\n"))
        self.fail("worktree_changed", Writer)
        self.assertEqual((self.a / "library/one.md").read_bytes(), note("new live edit\n"))
        self.assertEqual(oid(self.a), self.initial)

    def test_concurrent_stage_before_commit_preserved(self):
        fixture = self
        self.write(self.a, "library/one.md", note("mine\n"))
        class Writer(Sync):
            def checkpoint(self, phase, **values):
                super().checkpoint(phase, **values)
                if phase == "before_stage":
                    fixture.write(fixture.a, "tool.py", b"other actor\n")
                    fixture.g(fixture.a, "add", "--", "tool.py")
        self.fail("worktree_changed", Writer)
        self.assertEqual(self.g(self.a, "show", ":tool.py"), b"other actor\n")
        self.assertEqual(oid(self.a), self.initial)

    def test_remote_advances_before_push_recomputes(self):
        fixture = self
        self.write(self.a, "library/one.md", note("mine\n"))
        class Racer(Sync):
            raced = False
            def checkpoint(self, phase, **values):
                super().checkpoint(phase, **values)
                if phase == "before_push" and not self.raced:
                    self.raced = True
                    fixture.remote_change("library/two.md", note("remote racer\n"))
        self.assertEqual(self.sync(Racer)["status"], "synced")
        self.assertEqual(self.g(self.remote, "show", "main:library/one.md"), note("mine\n"))
        self.assertEqual(self.g(self.remote, "show", "main:library/two.md"), note("remote racer\n"))

    def test_precommit_hook_failure_keeps_staging_and_remote(self):
        hook = self.base / "phone-hooks/pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o700)
        self.write(self.a, "library/one.md", note("kept after hook failure\n"))
        self.fail("git_failed")
        self.assertEqual(oid(self.remote, "main"), self.initial)
        self.assertEqual(self.g(self.a, "show", ":library/one.md"), note("kept after hook failure\n"))

    def test_separate_gitdir_and_linked_worktree(self):
        other = self.base / "shared-storage"
        private = self.base / "private.git"
        result = execute(["git", "clone", "--separate-git-dir=" + str(private),
                          "--config", "core.symlinks=false", str(self.remote), str(other)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.configure(other)
        self.config = dataclasses.replace(self.config, repo=other)
        self.write(other, "library/one.md", note("separate gitdir\n"))
        self.assertEqual(self.sync()["status"], "synced")
        self.assertEqual((other / ".git").read_text(), "gitdir: " + str(private) + "\n")

    def test_interrupted_after_local_commit_can_resume(self):
        self.write(self.a, "library/one.md", note("survives interruption\n"))
        class Interrupted(Sync):
            def checkpoint(self, phase, **values):
                super().checkpoint(phase, **values)
                if phase == "local_committed":
                    raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.sync(Interrupted)
        self.assertEqual(self.g(self.a, "show", "HEAD:library/one.md"), note("survives interruption\n"))
        self.assertEqual(self.sync()["status"], "synced")

    def test_actual_merge_result_checked_even_with_custom_driver(self):
        attributes = self.write(self.a, ".gitattributes", b"library/*.md merge=keep-local\n")
        self.commit(self.a, [".gitattributes"])
        self.g(self.a, "push", "origin", "main")
        self.g(self.a, "config", "merge.keep-local.driver", "true")
        original = self.files["library/one.md"]
        self.write(self.a, "library/one.md", original.replace(b"two\n", b"two\nleft\n"))
        self.remote_change("library/one.md", original.replace(b"eight\n", b"eight\nright\n"))
        remote = oid(self.remote, "main")
        self.fail("merge_did_not_preserve_content")
        self.assertEqual(oid(self.remote, "main"), remote)
        self.assertTrue(attributes.exists())

    def test_remote_rename_with_local_edit_stops(self):
        self.write(self.a, "library/one.md", note("local\n"))
        self.g(self.b, "mv", "--", "library/two.md", "library/renamed.md")
        self.g(self.b, "commit", "-m", "rename fixture")
        self.g(self.b, "push", "origin", "main")
        self.fail("parallel_rename")
        self.assertTrue((self.a / "library/two.md").exists())

    def test_invalid_metadata_does_not_stage_or_commit(self):
        self.write(self.a, "library/one.md", b"missing metadata\n")
        index = Sync(self.config).index_bytes()
        self.fail("validation_failed")
        self.assertEqual(Sync(self.config).index_bytes(), index)
        self.assertEqual(oid(self.a), self.initial)

    def test_new_note_index_and_generated_outputs(self):
        self.write(self.a, "wiki/devices/new/new.md", note(OPENING + "entity\n", audience=["human", "agents"]))
        self.write(self.a, "wiki/home.md", note("[New](devices/new/new.md)\n", audience=["human", "agents"]))
        self.assertEqual(self.sync()["status"], "synced")
        self.command_gate(self.a, "pre-commit")
        changed = self.g(self.a, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").decode().splitlines()
        self.assertEqual(set(changed), {"wiki/devices/new/new.md", "wiki/home.md", "agents/infra/generated/wiki-entities.md"})

    def test_extra_root_note_requires_explicit_selection(self):
        self.write(self.a, "-root.md", note("explicit\n"))
        self.fail("protected_local_change")
        self.config = dataclasses.replace(self.config, extra_notes=("-root.md",))
        self.assertEqual(self.sync()["status"], "synced")

    def test_second_sync_cannot_take_live_lock(self):
        first = Sync(self.config)
        with first.lock():
            self.fail("sync_already_running")

    def test_remote_dirty_settings_collision_preserved(self):
        self.write(self.a, ".obsidian/app.json", b'{"local":true}\n')
        self.remote_change(".obsidian/app.json", b'{"remote":true}\n')
        self.fail("git_failed")
        self.assertEqual((self.a / ".obsidian/app.json").read_bytes(), b'{"local":true}\n')
        self.assertEqual(oid(self.a), self.initial)

    def test_push_rejection_retains_local_commit(self):
        hook = self.remote / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o700)
        self.write(self.a, "library/one.md", note("pending push\n"))
        self.fail("push_not_accepted")
        self.assertNotEqual(oid(self.a), self.initial)
        self.assertEqual(oid(self.remote, "main"), self.initial)
        hook.unlink()
        self.assertEqual(self.sync()["status"], "synced")

    def test_ignored_local_file_is_not_overwritten_by_incoming_file(self):
        path = "library/incoming.md"
        exclude = self.a / ".git/info/exclude"
        with exclude.open("a") as stream:
            stream.write("\n/" + path + "\n")
        private = note("private ignored draft\n")
        self.write(self.a, path, private)
        self.assertEqual(self.g(self.a, "status", "--porcelain"), b"")
        remote = self.remote_change(path, note("new remote note\n"))
        self.fail("git_failed")
        self.assertEqual((self.a / path).read_bytes(), private)
        self.assertEqual(oid(self.a), self.initial)
        self.assertEqual(oid(self.remote, "main"), remote)
        self.assertEqual(self.g(self.a, "diff", "--cached", "--name-only"), b"")

    def test_interruption_at_each_transaction_boundary(self):
        for boundary in ("prepared", "before_stage", "local_committed", "fetched", "candidate_ready",
                         "before_apply", "applied", "before_push", "pushed"):
            with self.subTest(boundary=boundary):
                content = note("interrupted at " + boundary + "\n")
                self.write(self.a, "library/one.md", content)
                class Interrupted(Sync):
                    def checkpoint(self, phase, **values):
                        super().checkpoint(phase, **values)
                        if phase == boundary:
                            raise KeyboardInterrupt
                with self.assertRaises(KeyboardInterrupt):
                    self.sync(Interrupted)
                self.assertEqual((self.a / "library/one.md").read_bytes(), content)
                self.assertEqual(self.sync()["status"], "synced")
                self.assertEqual(self.g(self.remote, "show", "main:library/one.md"), content)

    def test_cli_sigterm_during_push_kills_owned_child_and_resumes(self):
        profile = self.base / "profile.json"
        profile.write_text(json.dumps(dataclasses.asdict(self.config), default=str))
        marker = self.base / "hook.pid"
        hook = self.base / "phone-hooks/pre-push"
        hook.write_text("#!/bin/sh\nprintf '%s\\n' \"$$\" > " + shlex.quote(str(marker)) + "\nsleep 30\n")
        hook.chmod(0o700)
        self.write(self.a, "library/one.md", note("process interruption\n"))
        process = subprocess.Popen([sys.executable, str(SCRIPT), "sync", "--config", str(profile), "--editor-paused"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(marker.exists())
            child = int(marker.read_text())
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130, stderr.decode())
            self.assertEqual(json.loads(stdout)["status"], "interrupted")
            proc = Path(f"/proc/{child}/stat")
            if proc.exists():
                self.assertEqual(proc.read_text().split(") ", 1)[1].split()[0], "Z")
            self.assertEqual(oid(self.remote, "main"), self.initial)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=5)
        hook.unlink()
        self.assertEqual(self.sync()["status"], "synced")

    def test_edit_after_push_is_reported_pending(self):
        fixture = self
        self.write(self.a, "library/one.md", note("pushed\n"))
        class Writer(Sync):
            def checkpoint(self, phase, **values):
                super().checkpoint(phase, **values)
                if phase == "pushed":
                    fixture.write(fixture.a, "library/one.md", note("not yet pushed\n"))
        self.assertEqual(self.sync(Writer)["status"], "local_changes_pending")
        self.assertEqual((self.a / "library/one.md").read_bytes(), note("not yet pushed\n"))
        self.assertEqual(self.g(self.remote, "show", "main:library/one.md"), note("pushed\n"))

    def test_private_worktrees_materialize_rule_symlinks_for_android(self):
        source = "agents/rules/machines/fixture/rules/01.md"
        alias = "agents/rules/machines/fixture/rules/02.md"
        incoming_alias = "agents/rules/machines/fixture/rules/03.md"
        output = "agents/rules/machines/fixture/AGENTS.md"
        self.write(self.a, source, note("fixture rule\n", audience=["agents"], scope=["machine:fixture"]))
        (self.a / alias).symlink_to("01.md")
        result = execute([sys.executable, str(VALIDATOR), "build-agents", "--root", str(self.a), "--machine", "fixture"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.commit(self.a, [source, alias, output])
        self.g(self.a, "push", "origin", "main")
        self.g(self.b, "pull", "--ff-only")
        self.g(self.a, "config", "core.symlinks", "false")
        (self.a / alias).unlink()
        (self.a / alias).write_text("01.md")
        self.assertEqual(self.g(self.a, "status", "--porcelain"), b"")
        (self.b / incoming_alias).symlink_to("01.md")
        self.commit(self.b, [incoming_alias])
        self.g(self.b, "push", "origin", "main")
        self.write(self.a, "library/one.md", note("local Android edit\n"))
        self.assertEqual(self.sync()["status"], "synced")
        self.assertEqual(self.g(self.a, "config", "core.symlinks").strip(), b"false")
        for name in (alias, incoming_alias):
            self.assertFalse((self.a / name).is_symlink())
            self.assertEqual((self.a / name).read_text(), "01.md")
        self.assertEqual(self.g(self.a, "status", "--porcelain"), b"")
        self.command_gate(self.a, "pre-commit")

    def test_generated_entity_and_machine_conflicts_are_rebuilt(self):
        source = "agents/rules/machines/fixture/rules/01.md"
        output = "agents/rules/machines/fixture/AGENTS.md"
        self.write(self.a, source, note("fixture instruction\n", audience=["agents"], scope=["machine:fixture"]))
        result = execute([sys.executable, str(VALIDATOR), "build-agents", "--root", str(self.a), "--machine", "fixture"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.commit(self.a, [source, output])
        self.g(self.a, "push", "origin", "main")
        self.g(self.b, "pull", "--ff-only")
        self.write(self.b, "wiki/devices/right/right.md", note(OPENING + "remote entity\n", audience=["human", "agents"], navigation_exclude="fixture"))
        remote_config = dataclasses.replace(self.config, repo=self.b, device="computer")
        self.assertEqual(Sync(remote_config).sync(True)["status"], "synced")
        self.write(self.a, "wiki/devices/left/left.md", note(OPENING + "local entity\n", audience=["human", "agents"], navigation_exclude="fixture"))
        result = self.sync()
        self.assertEqual(result["status"], "synced")
        self.assertEqual(result["copies"], [])
        for name in ("agents/infra/generated/wiki-entities.md", output):
            content = (self.a / name).read_text()
            self.assertIn("left", content)
            self.assertIn("right", content)
            self.assertNotIn("<<<<<<<", content)
        self.command_gate(self.a, "pre-commit")


if __name__ == "__main__":
    unittest.main()
