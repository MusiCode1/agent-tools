"""Exercise the client with real Git, replacing only the SSH transport and test tools."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class RemoteTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "HOME": str(self.root),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_AUTHOR_NAME": "Test",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }
        self.env.pop("GIT_SSH_COMMAND", None)
        self.env.pop("GIT_SSH", None)
        self.mirror = self.root / ".cache/heavy-run/remote-test/drive-coding.git"
        self.mirror.parent.mkdir(parents=True)
        self.git("init", "-q", "--bare", str(self.mirror))
        self.git("init", "-q")
        self.git("config", "ssh.variant", "ssh")
        self.git("remote", "add", "runner", "heavy-run-runner:drive-coding.git")
        self.commit("tracked", "committed\n")

        tools = {
            "ssh": f"""#!/usr/bin/env python3
import os, sys
command = sys.argv[-1]
with open(os.path.expanduser("~/ssh.log"), "a") as log:
    print(command, file=log)
if command.startswith("git-receive-pack") and os.environ.get("FAIL_PUSH"):
    sys.exit("original push error")
if command.startswith("remote-test-run") and os.environ.get("FAIL_SSH"):
    print("original SSH error", file=sys.stderr)
    sys.exit(255)
os.environ["SSH_ORIGINAL_COMMAND"] = command
os.execv({str(HERE / "runner")!r}, [{str(HERE / "runner")!r}])
""",
            "heavy-run": """#!/usr/bin/env python3
import os, sys
if sys.argv[1:] == ["status", "--local"]:
    print("runner queue")
    sys.exit(0)
assert sys.argv[1] == "--local"
command = sys.argv[sys.argv.index("--") + 1:]
os.execvp(command[0], command)
""",
            "bun": """#!/bin/sh
set -eu
test "$1" = install
test "$2" = --frozen-lockfile
mkdir -p node_modules
echo install >> "$HOME/installs"
""",
        }
        for name, script in tools.items():
            target = bin_dir / name
            target.write_text(script)
            target.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(["git", *args], env=self.env, cwd=self.repo, text=True)

    def commit(self, file, data):
        (self.repo / file).write_text(data)
        self.git("add", "--", file)
        self.git("commit", "-qm", file)

    def run_cli(self, *args, stdin=None, **overrides):
        return subprocess.run(
            [str(HERE / "remote-test"), *args], env={**self.env, **overrides},
            cwd=self.repo, input=stdin, text=True, capture_output=True, timeout=20,
        )

    def test_dirty_worktree_exits_before_contacting_runner(self):
        for filename in ("untracked", "tracked"):
            (self.repo / filename).write_text("changed")
            result = self.run_cli("--", "true")
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("יש שינויים לא מקומטים", result.stderr)
            self.assertFalse((self.root / "ssh.log").exists())
            (self.repo / filename).unlink()
        self.git("checkout", "--", "tracked")

    def test_push_and_ssh_failures_preserve_diagnostics_without_local_execution(self):
        for variable, error in (("FAIL_PUSH", "original push error"), ("FAIL_SSH", "original SSH error")):
            result = self.run_cli("--", "touch", str(self.repo / "ran-local"), **{variable: "1"})
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn(error, result.stderr)
            self.assertFalse((self.repo / "ran-local").exists())

    def test_prints_both_commands_with_quoting_and_preserves_output_and_status(self):
        script = 'cat tracked; cat; printf "%s" "$1" >&2; exit "$2"'
        for rc in (0, 3, 37, 126, 255):
            label = "a label with spaces"
            special = "one 'two'; $(false)"
            result = self.run_cli("--label", label, "--", "sh", "-c", script, "sh", special, str(rc),
                                  stdin="streamed input\n")
            self.assertEqual(result.returncode, rc, result.stderr)
            self.assertEqual(result.stdout, "committed\nstreamed input\n")
            self.assertTrue(result.stderr.endswith(special), result.stderr)
            push, ssh = result.stderr.splitlines()[:2]
            self.assertRegex(push, r"^git push --force --no-follow-tags --no-verify runner [0-9a-f]{40}:refs/heads/rt/[0-9a-f]{24}$")
            self.assertEqual(shlex.split(shlex.split(ssh)[-1])[-7:], ["--", "sh", "-c", script, "sh", special, str(rc)])
        refs = self.git("--git-dir", str(self.mirror), "for-each-ref", "--format=%(refname)").splitlines()
        self.assertEqual(len(refs), 1, refs)

    def test_runner_push_does_not_run_local_pre_push_hook(self):
        hook = self.repo / ".git/hooks/pre-push"
        hook.write_text('#!/bin/sh\ntouch "$HOME/pre-push-ran"\nexit 1\n')
        hook.chmod(0o755)
        result = self.run_cli("--", "true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "pre-push-ran").exists())

    def test_lockfile_controls_install(self):
        self.commit("bun.lock", "first")
        self.commit(".gitignore", "node_modules\n")
        for expected, commit in ((1, None), (1, ("tracked", "new")), (2, ("bun.lock", "second"))):
            if commit:
                self.commit(*commit)
            result = self.run_cli("--", "true")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.root / "installs").read_text().splitlines(), ["install"] * expected)

    def test_status_does_not_require_clean_worktree(self):
        (self.repo / "dirty").touch()
        result = self.run_cli("status")
        self.assertEqual((result.returncode, result.stdout), (0, "runner queue\n"), result.stderr)


if __name__ == "__main__":
    unittest.main()
