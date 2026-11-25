"""Integration tests of the public CLI and runner over a local SSH stand-in."""
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import unittest

HEAVY_RUN = Path(__file__).resolve().with_name("heavy-run")

SSH = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys

config = json.loads(Path(__file__).with_suffix(".json").read_text())
_, target, command, flag, operation, *args = sys.argv[sys.argv.index("--"):]
assert [command, flag] == ["heavy-run", "--runner"]
assert "BatchMode=yes" in sys.argv and "ForwardAgent=no" in sys.argv
assert "CLIENT_TOKEN" not in os.environ and "PORT" not in os.environ
with open(config["calls"], "a") as calls:
    calls.write(operation + "\n")
with open(config["targets"], "a") as targets:
    targets.write(target + "\n")
setting = Path(config["mode"]).read_text()
if setting == "offline":
    sys.exit(255)
if setting == "incompatible":
    print("old runner")
    sys.exit(0)
argv = [config["cli"], "--runner", operation, *args]
env = config["environment"]
if setting == "drop-result" and operation == "run":
    result = subprocess.run(argv, stdout=subprocess.PIPE, env=env, cwd=env["HOME"])
    assert result.stdout[-6:-5] == b"X"
    sys.stdout.buffer.write(result.stdout[:-6])
    sys.exit(255)
os.chdir(env["HOME"])
os.execve(argv[0], argv, env)
'''

BUN = """#!/bin/sh
case "$1" in
  --version) echo '1.2.3';;
  install)
    test "$2" = --frozen-lockfile || exit 2
    echo 'Bun installed fixture dependencies'
    echo install >> "$HOME/install-log"
    test "$(cat bun.lock)" != fail || exit 23
    mkdir -p node_modules
    cp bun.lock node_modules/installed-lock
    ;;
  *) exit 2;;
esac
"""


class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="heavy-run-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source repo"
        self.source.mkdir()
        self.home = self.root / "runner-home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.config = self.root / "config"
        self.config.mkdir()
        self.mode = self.root / "mode"
        self.mode.write_text("online")
        self.calls = self.root / "calls"
        self.targets = self.root / "targets"
        self.runner_state = self.home / "state"
        self.environment = os.environ.copy()
        self.environment.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HEAVY_RUN_DIR": str(self.root / "local-queue"),
            "HEAVY_RUN_REMOTE": "fake-runner",
            "XDG_CONFIG_HOME": str(self.config),
            "CLIENT_TOKEN": "local-only",
            "PORT": "4000",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        })
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "HEAVY_RUN_SLOTS"):
            self.environment.pop(key, None)
        environment = {
            "PATH": self.environment["PATH"],
            "HOME": str(self.home),
            "HEAVY_RUN_DIR": str(self.home / "queue"),
            "HEAVY_RUN_REMOTE": "prevent-recursion",
            "HEAVY_RUN_REMOTE_STATE": str(self.runner_state),
            "HEAVY_RUN_SLOTS": "4",
            "DC_DEPLOYMENT": "runner-environment",
            "PORT": "4999",
        }
        (self.bin / "ssh.json").write_text(json.dumps({
            "cli": str(HEAVY_RUN), "mode": str(self.mode), "calls": str(self.calls),
            "targets": str(self.targets),
            "environment": environment,
        }))
        self.executable("ssh", SSH)
        self.executable("bun", BUN)
        # Memory limits are exercised by test_heavy_run.sh on a systemd-enabled host.
        self.executable("systemctl", "#!/bin/sh\nexit 1\n")
        self.git("init", "-qb", "fixture")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("remote", "add", "origin", "https://example.invalid/source.git")
        (self.source / ".gitignore").write_text("ignored*\nnode_modules/\n")
        (self.source / "sub dir").mkdir()
        for name in ("text file", "delete staged", "delete worktree"):
            (self.source / "sub dir" / name).write_text("committed\n")
        (self.source / "binary").write_bytes(bytes(range(256)))
        self.git("add", ".")
        self.git("commit", "-qm", "Baseline")

    def executable(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    def git(self, *args, cwd=None):
        return subprocess.check_output(["git", *args], cwd=cwd or self.source, env=self.environment)

    def run_cli(self, *args, cwd=None, **kwargs):
        kwargs.setdefault("env", self.environment)
        kwargs.setdefault("capture_output", True)
        kwargs.setdefault("timeout", 20)
        return subprocess.run([HEAVY_RUN, *args], cwd=cwd or self.source, **kwargs)

    def launch(self, *args, cwd=None):
        process = subprocess.Popen([HEAVY_RUN, *args], cwd=cwd or self.source,
                                   env=self.environment, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=20)

        self.addCleanup(cleanup)
        return process

    def ok(self, result):
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        return result.stdout

    def test_snapshot_index_worktree_and_privacy(self):
        work = self.source / "sub dir"
        (work / "text file").write_text("staged\n")
        (self.source / "binary").write_bytes(b"\0staged\xff")
        self.git("add", "sub dir/text file", "binary")
        self.git("rm", "sub dir/delete staged")
        (work / "text file").write_text("unstaged\n")
        (self.source / "binary").write_bytes(b"\0unstaged\xff")
        (work / "delete worktree").unlink()
        (work / "new\nfile").write_text("untracked")
        (work / "intent").write_text("intent to add")
        self.git("add", "-N", "sub dir/intent")
        (work / "ignored-build").write_text("ignored")
        (work / ".env").write_text("local-secret")
        (work / ".npmrc").write_text("local-secret")
        (work / ".env.example").write_text("send-example")
        (work / "link").symlink_to("text file")
        script = '''
            test 'sub dir' = "${PWD##*/}" &&
            test ! -e .env && test ! -e .npmrc && test ! -e ignored-build &&
            test "$(cat .env.example)" = send-example &&
            test "$(cat link)" = unstaged &&
            test -z "${CLIENT_TOKEN-}${DC_DEPLOYMENT-}${PORT-}" &&
            test -z "$(git remote)" &&
            git symbolic-ref --short HEAD &&
            git rev-parse HEAD &&
            git status --porcelain -z &&
            git diff --cached --binary &&
            git diff --binary
        '''
        before = self.git("status", "--porcelain", "-z")
        received = self.ok(self.run_cli("--", "sh", "-c", script, cwd=work))
        expected = (b"fixture\n" + self.git("rev-parse", "HEAD") + before
                    + self.git("diff", "--cached", "--binary") + self.git("diff", "--binary"))
        # The original reports untracked private files and the runner omits them.
        for name in (b"sub dir/.env", b"sub dir/.npmrc"):
            expected = expected.replace(b"?? " + name + b"\0", b"")
        self.assertEqual(received, expected)
        self.assertEqual(self.git("status", "--porcelain", "-z"), before)
        self.assertEqual(self.calls.read_text(), "probe\nrun\n")

    def test_streams_argv_stdin_and_all_exit_codes(self):
        process = self.launch("--remote", "--", "sh", "-c",
                              'echo ready; sleep 2; printf "%s" "$1"; echo err >&2; exit 255',
                              "script", 'a b $(printf no)')
        ready, _, _ = select.select([process.stdout], [], [], 10)
        self.assertTrue(ready, "no streamed output")
        self.assertEqual(process.stdout.readline(), b"ready\n")
        self.assertIsNone(process.poll(), "output arrived only after the command ended")
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(stdout, b"a b $(printf no)")
        self.assertIn(b"err\n", stderr)
        self.assertEqual(process.returncode, 255)
        self.assertEqual(self.run_cli("--", "heavy-run-no-such-fixture-command").returncode, 127)
        payload = bytes(range(256)) * 900
        self.assertEqual(self.ok(self.run_cli("--", "cat", input=payload)), payload)

    def test_preserves_sparse_and_assume_unchanged_index_entries(self):
        self.git("update-index", "--skip-worktree", "sub dir/text file")
        self.git("update-index", "--assume-unchanged", "sub dir/delete staged")
        (self.source / "sub dir" / "text file").unlink()
        (self.source / "sub dir" / "delete staged").write_text("hidden change")
        result = self.run_cli("--", "sh", "-c", "git ls-files -v -z && git status --porcelain -z")
        self.assertEqual(self.ok(result), self.git("ls-files", "-v", "-z"))

    def test_same_worktree_and_different_worktrees(self):
        worktrees = [self.source]
        for number in range(3):
            path = self.root / f"checkout {number}"
            self.git("worktree", "add", "--detach", path, "HEAD")
            (path / "uniqueness").write_text(str(number))
            worktrees.append(path)
        first = self.launch("--", "sh", "-c", '''
            touch dirty-first "$HOME/started"
            until test -e "$HOME/release"; do sleep .05; done
            test ! -e uniqueness
        ''')
        try:
            until = time.monotonic() + 10
            while not (self.home / "started").exists() and time.monotonic() < until:
                time.sleep(.05)
            self.assertTrue((self.home / "started").exists())
            second = self.launch("--", "sh", "-c", "test ! -e dirty-first")
            ready, _, _ = select.select([second.stderr], [], [], 10)
            self.assertTrue(ready, "second job did not wait for the checkout")
            self.assertIn(b"waiting for the runner checkout", second.stderr.readline())
            others = [
                self.launch("--", "sh", "-c", '''
                    test "$(cat uniqueness)" = "$1" || exit 1
                    touch "$HOME/started-$1"
                    until test -e "$HOME/release"; do sleep .05; done
                ''', "script", str(number), cwd=path)
                for number, path in enumerate(worktrees[1:])
            ]
            until = time.monotonic() + 10
            while len(list(self.home.glob("started-*"))) < 3 and time.monotonic() < until:
                time.sleep(.05)
            self.assertEqual(len(list(self.home.glob("started-*"))), 3)
            self.assertIsNone(second.poll())
            status = self.ok(self.run_cli("status"))
            self.assertIn(b"local queue:", status)
            self.assertIn(b"remote queue:", status)
            self.assertIn(b"slots: 4", status)
        finally:
            (self.home / "release").touch()
        for process in [first, second, *others]:
            out, err = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, (out, err))
        self.assertEqual(len(list((self.runner_state / "git").glob("*.git"))), 1)

    def test_bun_fingerprint_and_failed_install(self):
        path = self.source / "sub dir"
        install_log = self.home / "install-log"
        (path / "bun.lock").write_text("one")
        (path / "node_modules").mkdir()
        (path / "node_modules" / "source-only").touch()
        (path / "package.json").write_text("{}")
        (self.source / "binary").write_bytes(b"\0cold snapshot\xff")
        self.git("add", "binary")
        expected = self.git("diff", "--cached", "--binary", cwd=path)
        cold = self.run_cli("--remote", "--", "git", "diff", "--cached", "--binary", cwd=path)
        self.assertEqual(self.ok(cold), expected)
        self.assertIn(b"Bun installed fixture dependencies\n", cold.stderr)
        command = '''
            test ! -e node_modules/source-only && cat node_modules/installed-lock
        '''
        self.assertEqual(self.ok(self.run_cli("--", "sh", "-c", command, cwd=path)), b"one")
        self.assertEqual(install_log.read_text().splitlines(), ["install"])
        (path / "bun.lock").write_text("fail")
        bad = self.run_cli("--", "sh", "-c", "touch ~/executed", cwd=path)
        self.assertNotEqual(bad.returncode, 0)
        self.assertFalse((self.home / "executed").exists())
        (path / "bun.lock").write_text("two")
        self.assertEqual(self.ok(self.run_cli("--", "sh", "-c", command, cwd=path)), b"two")
        self.assertEqual(install_log.read_text().splitlines(), ["install"] * 3)

    def test_fallback_and_local_modes(self):
        self.mode.write_text("offline")
        result = self.run_cli("--", "sh", "-c", 'test "$PORT" = "" && exit 17')
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertEqual(result.stderr.count(b"SSH runner unavailable"), 1)
        self.assertEqual(self.calls.read_text(), "probe\n")
        for options in (["--local"], ["--preview"], ["--remote", "--preview"]):
            self.ok(self.run_cli(*options, "--", "true"))
        self.assertEqual(self.calls.read_text(), "probe\n")

    def test_no_fallback_after_probe(self):
        self.mode.write_text("drop-result")
        result = self.run_cli("--", "sh", "-c", 'printf once; touch command-ran')
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"once")
        self.assertIn(b"command may have started", result.stderr)
        self.assertFalse((self.source / "command-ran").exists())
        self.assertEqual(self.calls.read_text(), "probe\nrun\n")

    def test_config_file_and_incompatible_runner(self):
        (self.config / "heavy-run").mkdir()
        (self.config / "heavy-run" / "remote").write_text("fake-runner\n")
        self.environment.pop("HEAVY_RUN_REMOTE")
        self.ok(self.run_cli("--", "sh", "-c", 'test "$HOME" != "$PWD"'))
        self.mode.write_text("incompatible")
        result = self.run_cli("--", "touch", "should-not-exist")
        self.assertEqual(result.returncode, 125)
        self.assertIn(b"runner probe failed", result.stderr)
        self.assertFalse((self.source / "should-not-exist").exists())
        self.environment["HEAVY_RUN_REMOTE"] = ""
        self.ok(self.run_cli("--", "touch", "ran-locally"))
        self.assertTrue((self.source / "ran-locally").exists())

    def test_repository_opt_in_is_shared_by_linked_worktrees(self):
        self.environment.pop("HEAVY_RUN_REMOTE")
        linked = self.root / "linked worktree"
        self.git("worktree", "add", "-q", "--detach", linked, "HEAD")
        self.ok(self.run_cli("--", "touch", "ran-locally", cwd=linked))
        self.assertTrue((linked / "ran-locally").exists())
        self.assertFalse(self.calls.exists())

        self.git("config", "--local", "heavy-run.remote", "repo-runner", cwd=linked)
        self.git("config", "--local", "extensions.worktreeConfig", "true")
        self.git("config", "--worktree", "heavy-run.remote", "worktree-override", cwd=linked)
        self.assertEqual(self.git("config", "--local", "--get", "heavy-run.remote"), b"repo-runner\n")
        for checkout in (self.source, linked):
            result = self.run_cli("--", "sh", "-c", '''
                if git config --local --get heavy-run.remote; then exit 9; fi
                printf '%s' "$HOME"
            ''', cwd=checkout)
            self.assertEqual(self.ok(result), os.fsencode(self.home))
        self.assertEqual(self.targets.read_text().splitlines(), ["repo-runner"] * 4)

        unapproved = self.root / "unapproved repo"
        unapproved.mkdir()
        self.git("init", "-q", cwd=unapproved)
        self.ok(self.run_cli("--", "touch", "ran-locally", cwd=unapproved))
        self.assertTrue((unapproved / "ran-locally").exists())
        self.assertEqual(self.calls.read_text().splitlines(), ["probe", "run"] * 2)

    def test_destination_precedence_and_empty_opt_out(self):
        (self.config / "heavy-run").mkdir()
        (self.config / "heavy-run" / "remote").write_text("global-runner\n")
        self.environment.pop("HEAVY_RUN_REMOTE")
        self.assertIn(b"remote queue:", self.ok(self.run_cli("status")))
        self.git("config", "--local", "heavy-run.remote", "repo-runner")
        self.assertIn(b"remote queue:", self.ok(self.run_cli("status")))
        self.environment["HEAVY_RUN_REMOTE"] = "env-runner"
        self.assertIn(b"remote queue:", self.ok(self.run_cli("status")))
        self.environment["HEAVY_RUN_REMOTE"] = ""
        self.assertNotIn(b"remote queue:", self.ok(self.run_cli("status")))
        self.environment.pop("HEAVY_RUN_REMOTE")
        self.git("config", "--local", "heavy-run.remote", "")
        self.assertNotIn(b"remote queue:", self.ok(self.run_cli("status")))
        self.assertEqual(self.targets.read_text().splitlines(), ["global-runner", "repo-runner", "env-runner"])

    def test_bundle_contains_reachable_history_only(self):
        self.git("switch", "-qc", "unrelated")
        self.git("commit", "--allow-empty", "-qm", "Unrelated commit")
        unrelated = self.git("rev-parse", "HEAD").strip().decode()
        self.git("switch", "-q", "fixture")
        (self.source / ".env").write_text("historical fixture\n")
        self.git("add", ".env")
        self.git("commit", "-qm", "Historical fixture")
        self.git("rm", ".env")
        self.git("commit", "-qm", "Remove fixture from current tree")
        result = self.run_cli("--", "sh", "-c", '''
            if git cat-file -e "$1^{commit}" 2>/dev/null; then exit 8; fi
            test ! -e .env && git show HEAD^:.env
        ''', "script", unrelated)
        self.assertEqual(self.ok(result), b"historical fixture\n")

    def test_unsafe_symlink_and_private_staging_are_rejected(self):
        outside = self.root / "outside"
        outside.write_text("private")
        (self.source / "external-link").symlink_to("../outside")
        result = self.run_cli("--", "true")
        self.assertEqual(result.returncode, 125)
        self.assertIn(b"unsafe symlink", result.stderr)
        self.assertEqual(self.calls.read_text(), "probe\n")
        (self.source / "external-link").unlink()
        (self.source / ".env").write_text("private")
        self.git("add", ".env")
        result = self.run_cli("--", "true")
        self.assertEqual(result.returncode, 125)
        self.assertIn(b"unsupported snapshot path '.env'", result.stderr)
        self.assertEqual(self.calls.read_text(), "probe\nprobe\n")


if __name__ == "__main__":
    unittest.main()
