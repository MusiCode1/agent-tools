#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from install_profile import install

SCRIPT = Path(__file__).with_name("install_profile.py")


def profile(device, **extra):
    return {"repo": "/tmp/example-repo", "remote": "origin", "remote_url": "https://example.invalid/repo.git",
            "branch": "main", "device": device, "state_dir": "~/.local/state/git-sync",
            "commit_message": "sync", "merge_message": "merge", **extra}


class InstallProfileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="profile-install-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.profiles = base / "profiles"
        self.profiles.mkdir()
        (self.profiles / "laptop.json").write_text(json.dumps(profile("laptop")))
        (self.profiles / "server.json").write_text(json.dumps(profile("server", mode="mirror")))
        (self.profiles / "wrong.json").write_text(json.dumps(profile("other")))
        self.target = base / "config" / "profile.json"

    def test_install_then_unchanged_then_refuse_different_then_replace_with_backup(self):
        source = self.profiles / "laptop.json"
        r = install(source, self.target)
        self.assertEqual(r["status"], "installed")
        self.assertEqual(self.target.read_bytes(), source.read_bytes())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(install(source, self.target)["status"], "unchanged")
        self.target.write_text('{"edited": "locally"}\n')
        r = install(source, self.target)
        self.assertEqual(r["reason"], "installed_profile_differs")
        self.assertEqual(self.target.read_text(), '{"edited": "locally"}\n', "never overwritten without --replace")
        r = install(source, self.target, replace=True)
        self.assertEqual(r["status"], "installed")
        self.assertEqual(Path(r["backup"]).read_text(), '{"edited": "locally"}\n')
        self.assertEqual(self.target.read_bytes(), source.read_bytes())

    def test_mirror_profile_needs_no_merge_message(self):
        data = profile("server", mode="mirror")
        del data["merge_message"]
        (self.profiles / "server.json").write_text(json.dumps(data))
        self.assertEqual(install(self.profiles / "server.json", self.target)["status"], "installed")

    def test_unknown_malformed_and_mismatched_names_stop(self):
        r = install(self.profiles / "nosuch.json", self.target)
        self.assertEqual(r["reason"], "unknown_device")
        self.assertEqual(r["known"], ["laptop", "server", "wrong"])
        self.assertEqual(install(self.profiles / "bad name.json", self.target)["reason"], "invalid_device_name")
        self.assertEqual(install(self.profiles / "wrong.json", self.target)["reason"], "device_name_mismatch")
        self.assertFalse(self.target.exists())

    def test_cli_reports_json_and_exit_codes(self):
        run = lambda *a: subprocess.run([sys.executable, str(SCRIPT), *a, "--target", str(self.target)],
                                        capture_output=True, text=True, timeout=60)
        r = run(str(self.profiles / "laptop.json"))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)["status"], "installed")
        self.target.write_text("{}\n")
        r = run(str(self.profiles / "laptop.json"))
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
