#!/usr/bin/env python3
"""Install a profile from a repository into the local path the sync reads.

Profiles live in the repository they describe (the source and the record); the
copy under ~/.config is what git_sync.py trusts at run time. A change pushed to
the repository therefore takes effect on a machine only when someone installs
it there — a commit cannot widen note_roots or move remote_url by itself.

    python3 install_profile.py <profiles-dir>/<device>.json [--replace] [--target PATH]

Exit codes: 0 installed or unchanged · 2 needs attention (differs, invalid).
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from git_sync import Config, Stop

DEFAULT_TARGET = "~/.config/knowledge-git-sync/profile.json"


def install(profile, target, replace=False):
    source = Path(profile).expanduser()
    device = source.stem
    if not re.fullmatch(r"[A-Za-z0-9._-]+", device):
        return {"status": "needs_attention", "reason": "invalid_device_name"}
    if not source.is_file():
        known = sorted(p.stem for p in source.parent.glob("*.json")) if source.parent.is_dir() else []
        return {"status": "needs_attention", "reason": "unknown_device", "known": known}
    data = source.read_bytes()
    config = Config.load(source)
    config.validate()
    if config.device != device:
        return {"status": "needs_attention", "reason": "device_name_mismatch", "profile_device": config.device}
    target = Path(target).expanduser()
    backup = None
    if target.exists():
        current = target.read_bytes()
        if current == data:
            return {"status": "unchanged", "target": str(target)}
        if not replace:
            diff = difflib.unified_diff(current.decode(errors="replace").splitlines(),
                                        data.decode().splitlines(), "installed", "repository", lineterm="")
            print("\n".join(diff), file=sys.stderr)
            return {"status": "needs_attention", "reason": "installed_profile_differs",
                    "target": str(target), "fix": "review the diff, then rerun with --replace"}
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"{target.name}.bak-{stamp}")
        backup.write_bytes(current)
        os.chmod(backup, 0o600)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".profile-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return {"status": "installed", "target": str(target), "backup": str(backup) if backup else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("profile", help="path to <device>.json in the repository it describes")
    parser.add_argument("--replace", action="store_true", help="overwrite a different installed profile (a backup is kept)")
    parser.add_argument("--target", default=DEFAULT_TARGET)
    args = parser.parse_args(argv)
    try:
        result = install(args.profile, args.target, args.replace)
    except Stop as exc:
        result = {**exc.result, "reason": "invalid_profile:" + exc.result["reason"]}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        result = {"status": "needs_attention", "reason": "invalid_profile:" + type(exc).__name__}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in {"installed", "unchanged"} else 2


if __name__ == "__main__":
    sys.exit(main())
