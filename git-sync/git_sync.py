#!/usr/bin/env python3
"""Explicit Git synchronization for a working tree, in one of three modes.

notes   commit the local notes of an exclusively owned, paused editor tree,
        merge in a private worktree with recoverable conflict copies, push.
mirror  keep a read-only mirror of the remote branch: never commit; update
        with a fast-forward only, and report (do not touch) any local change.
append  move a pending append-only log from outside the repository into a
        tracked file through a private worktree, commit and push; the local
        working tree is never touched.

The JSON profile lives outside the repository. Read-only commands never fetch,
refresh the index, create locks, or install dependencies. Recovery refs and the
private journal are intentionally retained; this tool has no pruning command.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

import yaml


# notes mode: the knowledge repository's own validator and layout contract.
DEFAULT_VALIDATOR = "agents/infra/scripts/knowledge_tools.py"
CONTRACT = "agents/infra/config/knowledge-layout.json"
MODES = ("notes", "mirror", "append")
OPERATIONS = ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
              "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock")
FRONTMATTER = re.compile(rb"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.S)
PROTECTED_NAMES = {"AGENTS.md", "CLAUDE.md", "GEMINI.md"}


class Stop(Exception):
    def __init__(self, reason, *, status="needs_attention", **details):
        self.result = {"status": status, "reason": reason, **details}
        super().__init__(reason)


def execute(argv, *, cwd=None, data=None, timeout=45):
    # Do not inherit a caller's alternate index, worktree or command-scope Git
    # configuration. Authentication helpers still receive their normal tokens.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C.UTF-8")
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    try:
        out, err = process.communicate(data, timeout=timeout)
    except BaseException as exc:
        # Only the process group created by this invocation is ours to kill.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        if isinstance(exc, subprocess.TimeoutExpired):
            raise Stop("command_timeout", command=Path(argv[0]).name) from exc
        raise
    return subprocess.CompletedProcess(argv, process.returncode, out, err)


def git(root, *args, check=True, data=None, timeout=45, native_symlinks=False):
    options = ["-c", "core.symlinks=true"] if native_symlinks else []
    result = execute(["git", "--literal-pathspecs", *options, "-C", str(root), *args],
                     data=data, timeout=timeout)
    if check and result.returncode:
        # Raw stderr may contain remote credentials or user content.
        raise Stop("git_failed", command=args[0], returncode=result.returncode)
    return result.stdout if check else result


def oid(root, ref="HEAD"):
    return git(root, "rev-parse", "--verify", ref).decode().strip()


def relative_path(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise Stop("invalid_path")
    p = PurePosixPath(value)
    if p.is_absolute() or str(p) != value or any(x in {".", ".."} for x in p.parts):
        raise Stop("invalid_path", path=value)
    return p


def safe_file(root, name):
    p = root / relative_path(name)
    for parent in [p, *p.parents]:
        if parent == root:
            return p
        if parent.is_symlink():
            raise Stop("symlink_path", path=name)
    raise Stop("path_outside_repository", path=name)


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def names(raw):
    return [x.decode("utf-8") for x in raw.split(b"\0") if x]


def tree(root, ref):
    result = {}
    for item in git(root, "ls-tree", "-r", "-z", ref).split(b"\0"):
        if item:
            info, name = item.split(b"\t", 1)
            mode, kind, blob = info.decode().split()
            result[name.decode()] = (mode, kind, blob)
    return result


def subsequence(original, changed):
    """Byte-line preservation, including ordering, multiplicity and line endings."""
    remaining = iter(changed.splitlines(keepends=True))
    return all(any(line == candidate for candidate in remaining)
               for line in original.splitlines(keepends=True))


def generated_path(name):
    return (name in {"agents/infra/generated/wiki-entities.md", "agents/procedures/INDEX.md",
                     "agents/infra/generated/entity-workflows.md"}
            or re.fullmatch(r"agents/rules/machines/[^/]+/AGENTS\.md", name) is not None)


@dataclass
class Config:
    repo: Path
    remote: str
    remote_url: str
    branch: str
    device: str
    state_dir: Path
    commit_message: str
    merge_message: str = ""
    mode: str = "notes"
    validator: str = DEFAULT_VALIDATOR
    pending: str = ""
    target: str = ""
    json_lines: bool = False
    note_roots: tuple = ("library", "wiki")
    extra_notes: tuple = ()
    exclusive_worktree: bool = False
    quiet_seconds: float = 3
    command_timeout: int = 45
    max_attempts: int = 3

    @classmethod
    def load(cls, path):
        values = json.loads(path.read_text())
        for key in ("repo", "state_dir"):
            values[key] = Path(values[key]).expanduser().resolve()
        if values.get("pending"):
            values["pending"] = str(Path(values["pending"]).expanduser().resolve())
        return cls(**values)

    def validator_path(self):
        p = Path(self.validator).expanduser()
        return p if p.is_absolute() else self.repo / relative_path(self.validator)

    def allowed(self, name):
        p = relative_path(name)
        if p.suffix.lower() != ".md" or p.name in PROTECTED_NAMES:
            return False
        if any(x.startswith(".") for x in p.parts):
            return False
        return (any(name.startswith(root + "/") for root in self.note_roots)
                or (len(p.parts) == 1 and name in self.extra_notes))

    def validate(self):
        for value in (self.remote, self.device):
            if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,31}", value):
                raise Stop("invalid_identifier")
        if not isinstance(self.remote_url, str) or not self.remote_url:
            raise Stop("missing_remote_identity")
        if not isinstance(self.branch, str) or self.branch.startswith("-"):
            raise Stop("invalid_branch")
        if not 1 <= self.max_attempts <= 5 or not 1 <= self.command_timeout <= 120:
            raise Stop("invalid_limits")
        if not 0 <= self.quiet_seconds <= 300:
            raise Stop("invalid_quiet_window")
        if self.mode not in MODES:
            raise Stop("invalid_mode", mode=self.mode)
        if not self.commit_message.strip() and self.mode != "mirror":
            raise Stop("missing_commit_message")
        if self.state_dir.is_relative_to(self.repo):
            raise Stop("state_must_be_outside_worktree")
        if self.mode == "append":
            if not self.pending or Path(self.pending).is_relative_to(self.repo):
                raise Stop("pending_must_be_outside_worktree")
            relative_path(self.target)
            return
        if self.mode == "mirror":
            return
        for root in self.note_roots:
            if relative_path(root).parts[0] not in {"library", "wiki"}:
                raise Stop("protected_root", path=root)
        for name in self.extra_notes:
            if len(relative_path(name).parts) != 1 or not self.allowed(name):
                raise Stop("invalid_extra_note", path=name)
        if not self.merge_message.strip():
            raise Stop("missing_commit_message")


class Sync:
    def __init__(self, config):
        self.c = config
        config.validate()
        self.validator = config.validator_path()
        self.root = config.repo
        self.run_dir = None
        self.record = {}
        self.copies = set()
        self.progress = None          # a text stream for human progress lines (stderr), or None
        self.started = time.monotonic()

    def say(self, message):
        if self.progress is not None:
            print(f"[{time.monotonic() - self.started:5.1f}s] {message}", file=self.progress, flush=True)

    def g(self, *args, **kwargs):
        return git(self.root, *args, timeout=self.c.command_timeout, **kwargs)

    def private_git(self, path, *args, **kwargs):
        return git(path, *args, timeout=self.c.command_timeout, native_symlinks=True, **kwargs)

    def identity(self):
        if Path(self.g("rev-parse", "--show-toplevel").decode().strip()).resolve() != self.root:
            raise Stop("not_repository_root")
        self.g("check-ref-format", "refs/heads/" + self.c.branch)
        branch = self.g("symbolic-ref", "-q", "HEAD").decode().strip()
        if branch != "refs/heads/" + self.c.branch:
            raise Stop("wrong_branch", branch=branch)
        for options in ((), ("--push",)):
            urls = self.g("remote", "get-url", *options, "--all", self.c.remote).decode().splitlines()
            if urls != [self.c.remote_url]:
                raise Stop("remote_identity_changed")
        # Without a committer identity, the commit fails in the middle of sync with a bare
        # git_failed/128; check it here so status and plan already say what is missing.
        if self.g("var", "GIT_COMMITTER_IDENT", check=False).returncode:
            raise Stop("missing_git_identity", fix="git config user.name … && git config user.email …")
        if self.g("config", "--bool", "core.sparseCheckout", check=False).stdout.strip() == b"true":
            raise Stop("sparse_checkout_unsupported")
        if self.c.mode == "notes" and (not safe_file(self.root, CONTRACT).is_file()
                                       or not self.validator.is_file()):
            raise Stop("knowledge_contract_missing")
        common = Path(self.g("rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip())
        if self.c.state_dir.is_relative_to(common.resolve()):
            raise Stop("state_must_be_outside_gitdir")

    def idle(self):
        self.identity()
        for name in OPERATIONS:
            path = Path(self.g("rev-parse", "--path-format=absolute", "--git-path", name).decode().strip())
            if path.exists():
                raise Stop("git_operation_in_progress", operation=name)
        if self.g("diff", "--cached", "--name-only", "-z"):
            raise Stop("staged_changes")

    def inspect(self):
        self.idle()
        selected, settings = [], []
        entries = tree(self.root, "HEAD")
        for item in self.g("status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all").split(b"\0"):
            if not item:
                continue
            code, name = item[:2].decode(), item[3:].decode()
            if name.startswith(".obsidian/"):
                settings.append(name)
                continue
            if code not in {" M", "??"}:
                raise Stop("unsupported_local_change", path=name, change=code)
            if not self.c.allowed(name):
                raise Stop("protected_local_change", path=name)
            path = safe_file(self.root, name)
            if not path.is_file() or (name in entries and entries[name][0] != "100644"):
                raise Stop("unsupported_file_type", path=name)
            if path.stat().st_mode & 0o111:
                raise Stop("executable_note", path=name)
            selected.append(name)
        return {"status": "ready", "head": oid(self.root), "files": sorted(selected),
                "device_settings": sorted(settings), "network_checked": False}

    def fingerprint(self):
        # Ignored caches and external symlink targets are never traversed.
        paths = names(self.g("ls-files", "--cached", "--others", "--exclude-standard", "-z"))
        result = {}
        for name in sorted(set(paths)):
            path = self.root / relative_path(name)
            try:
                mode = path.lstat().st_mode
            except FileNotFoundError:
                result[name] = ["missing"]
                continue
            if stat.S_ISLNK(mode):
                result[name] = ["link", os.readlink(path)]
            elif stat.S_ISREG(mode):
                data = safe_file(self.root, name).read_bytes()
                result[name] = ["file", mode & 0o111, hashlib.sha256(data).hexdigest()]
            else:
                raise Stop("unsupported_file_type", path=name)
        return result

    def index_bytes(self):
        path = Path(self.g("rev-parse", "--path-format=absolute", "--git-path", "index").decode().strip())
        return path.read_bytes()

    def guard(self, head, files, index=None):
        self.identity()
        if oid(self.root) != head or self.fingerprint() != files:
            raise Stop("worktree_changed")
        if index is not None and self.index_bytes() != index:
            raise Stop("index_changed")

    def checkpoint(self, phase, **values):
        self.record.update(phase=phase, **values)
        atomic_write(self.run_dir / "journal.json",
                     json.dumps(self.record, ensure_ascii=True, indent=2).encode() + b"\n")

    def save_ref(self, label, value):
        ref = self.record["ref_prefix"] + "/" + label
        self.g("update-ref", ref, value, "0" * len(value))
        return ref

    @contextmanager
    def lock(self):
        key = hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        state = self.c.state_dir / key
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        if state.is_symlink() or state.stat().st_uid != os.getuid() or state.stat().st_mode & 0o077:
            raise Stop("insecure_state_directory")
        fd = os.open(state / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Stop("sync_already_running", status="busy") from exc
            run = uuid.uuid4().hex
            self.run_dir = state / run
            self.run_dir.mkdir(mode=0o700)
            self.record = {"repo": str(self.root), "run": run,
                           "ref_prefix": "refs/knowledge-sync/" + run}
            yield
        finally:
            os.close(fd)

    def worktree(self, label, head):
        path = self.run_dir / label
        # The private filesystem supports links even when Android's shared
        # editor tree requires core.symlinks=false. Do not change common config.
        self.g("worktree", "add", "--detach", str(path), head, native_symlinks=True)
        self.checkpoint("worktree_created", worktree=str(path))
        return path

    def validate(self, path, command="pre-commit"):
        result = execute([sys.executable, str(self.validator), command, "--root", str(path)],
                         timeout=self.c.command_timeout)
        if result.returncode:
            atomic_write(self.run_dir / "validation-error.txt", result.stdout + result.stderr)
            raise Stop("validation_failed", command=command,
                       evidence=str(self.run_dir / "validation-error.txt"))

    def stage(self, path, paths):
        # A literal NUL-delimited enumeration, never a directory, glob or -A.
        if paths:
            git(path, "add", "--pathspec-from-file=-", "--pathspec-file-nul",
                data=b"\0".join(x.encode() for x in sorted(paths)) + b"\0",
                timeout=self.c.command_timeout, native_symlinks=path != self.root)

    def generated(self, path):
        layout = json.loads(safe_file(path, CONTRACT).read_text())
        outputs = [layout["outputs"]["entities"], layout["outputs"]["workflows"]]
        if (outputs != ["agents/infra/generated/wiki-entities.md", "agents/procedures/INDEX.md"]
                or layout["roots"]["machine_rules"] != "agents/rules/machines"):
            raise Stop("generation_contract_changed")
        # workflows-index also writes the index of runbooks that sit next to their entity
        # (added 2026-11-04); a note edit can legitimately change it.
        extra = layout["outputs"].get("entity_workflows")
        if extra is not None:
            if extra != "agents/infra/generated/entity-workflows.md":
                raise Stop("generation_contract_changed")
            outputs.append(extra)
        for command in ("wiki-index", "workflows-index"):
            self.validate(path, command)
        machines = safe_file(path, layout["roots"]["machine_rules"])
        if machines.is_dir():
            for folder in sorted(machines.iterdir()):
                if folder.is_symlink() or not (folder / "rules").is_dir():
                    continue
                result = execute([sys.executable, str(self.validator), "build-agents", "--root", str(path),
                                  "--machine", folder.name], timeout=self.c.command_timeout)
                if result.returncode:
                    evidence = self.run_dir / "generation-error.txt"
                    atomic_write(evidence, result.stdout + result.stderr)
                    raise Stop("generated_output_failed", machine=folder.name, evidence=str(evidence))
                outputs.append(str((folder / "AGENTS.md").relative_to(path)))
        return outputs

    def local_commit(self, inspection, files, index):
        selected = inspection["files"]
        head = inspection["head"]
        if not selected:
            return head
        scratch = self.worktree("prepare", head)
        for name in selected:
            source = safe_file(self.root, name)
            if time.time() - source.stat().st_mtime < self.c.quiet_seconds:
                raise Stop("editing_not_quiet", path=name, status="busy")
            data = source.read_bytes()
            if b"\0" in data:
                raise Stop("binary_note", path=name)
            data.decode("utf-8")
            atomic_write(self.run_dir / "originals" / hashlib.sha256(name.encode()).hexdigest(), data)
            atomic_write(safe_file(scratch, name), data)
        outputs = self.generated(scratch)
        changed = set(names(self.private_git(scratch, "diff", "--name-only", "-z"))) | set(selected)
        if changed - set(outputs) - set(selected):
            raise Stop("unexpected_generated_change")
        self.stage(scratch, changed)
        self.say("בודק את תוכן הפתקים (pre-commit)…")
        self.validate(scratch)
        expected_tree = oid(scratch, self.private_git(scratch, "write-tree").decode().strip())
        self.checkpoint("before_stage", selected=selected, staged_paths=sorted(changed))
        self.guard(head, files, index)
        for name in sorted(changed - set(selected)):
            atomic_write(safe_file(self.root, name), safe_file(scratch, name).read_bytes())
        expected_files = self.fingerprint()
        # Only generated files may have changed since the initial snapshot.
        for name in set(files) | set(expected_files):
            if name not in changed - set(selected) and files.get(name) != expected_files.get(name):
                raise Stop("worktree_changed")
        self.idle()
        self.stage(self.root, changed)
        self.guard(head, expected_files)
        if self.g("write-tree").decode().strip() != expected_tree:
            raise Stop("unexpected_staging")
        self.validate(self.root)
        self.g("commit", "-m", self.c.commit_message)
        current = oid(self.root)
        if oid(self.root, "HEAD^{tree}") != expected_tree or oid(self.root, "HEAD^") != head:
            raise Stop("unexpected_commit")
        self.guard(current, expected_files)
        self.idle()
        self.checkpoint("local_committed", local=current)
        self.say("נשמר קומיט מקומי")
        # Align our detached scratch HEAD with its identical index/worktree;
        # there is no file restoration or modification of a shared branch.
        self.private_git(scratch, "update-ref", "--no-deref", "HEAD", current, head)
        self.g("worktree", "remove", str(scratch))
        return current

    def conflict_copy(self, path, original, local_blob, remote_blob):
        match = FRONTMATTER.match(original)
        if not match:
            raise Stop("conflict_metadata_missing", path=path)
        meta = yaml.safe_load(match.group(1).decode())
        if not isinstance(meta, dict) or not meta.get("title") or not isinstance(meta.get("audience"), list):
            raise Stop("conflict_metadata_invalid", path=path)
        identity = hashlib.sha256((path + "\0" + local_blob + "\0" + remote_blob).encode()).hexdigest()
        note = PurePosixPath(path)
        suffix = f" (conflict {self.c.device}-{identity[:16]}).md"
        stem = note.stem
        while len((stem + suffix).encode()) > 240:
            stem = stem[:-1]
        target = str(note.with_name(stem + suffix))
        header = {"title": f"{meta['title']} (conflict {self.c.device})", "audience": meta["audience"],
                  "lifecycle": "history", "conflict_id": identity, "conflict_source": path,
                  "conflict_device": self.c.device, "conflict_local_blob": local_blob,
                  "conflict_remote_blob": remote_blob}
        eol = b"\r\n" if original.startswith(b"---\r\n") else b"\n"
        rendered = yaml.safe_dump(header, allow_unicode=True, sort_keys=False).encode().replace(b"\n", eol)
        return target, b"---" + eol + rendered + b"---" + eol + original[match.end():]

    def merge_candidate(self, local, remote, attempt):
        bases = self.g("merge-base", "--all", local, remote).decode().splitlines()
        if len(bases) != 1:
            raise Stop("ambiguous_merge_base")
        base = bases[0]
        b, l, r = (tree(self.root, x) for x in (base, local, remote))
        local_changed = {p for p in set(b) | set(l) if b.get(p) != l.get(p)}
        remote_changed = {p for p in set(b) | set(r) if b.get(p) != r.get(p)}
        if any(p not in l for p in local_changed):
            raise Stop("local_deletion_or_rename")
        # A directory rename can move a newly added local note even without a
        # textual conflict. This first version leaves such decisions to a person.
        rename_records = iter(self.g("diff", "--name-status", "-z", "--find-renames", base, remote).split(b"\0"))
        for change in rename_records:
            if not change:
                continue
            next(rename_records)
            if change[:1] in {b"R", b"C"}:
                next(rename_records)
                if local_changed:
                    raise Stop("parallel_rename")
        copies, must_preserve = {}, {}
        for name in sorted(local_changed & remote_changed):
            if l.get(name) == r.get(name):
                continue
            if generated_path(name):
                continue  # Rebuilt from checked sources, never textually resolved.
            if (name not in l or name not in r
                    or any(t.get(name, ("100644",))[0] != "100644" for t in (b, l, r))):
                raise Stop("structural_conflict", path=name)
            if not self.c.allowed(name):
                raise Stop("protected_parallel_edit", path=name)
            left, right = (self.g("cat-file", "blob", t[name][2]) for t in (l, r))
            before = self.g("cat-file", "blob", b[name][2]) if name in b else b""
            for data in (before, left, right):
                if b"\0" in data:
                    raise Stop("binary_conflict", path=name)
                data.decode("utf-8")
            buffers = []
            for label, data in (("left", left), ("base", before), ("right", right)):
                buffer = self.run_dir / ("merge-" + label)
                atomic_write(buffer, data)
                buffers.append(str(buffer))
            merge = self.g("merge-file", "-p", *buffers, check=False)
            if merge.returncode not in range(0, 128):
                raise Stop("text_merge_failed", path=name)
            if not (merge.returncode == 0 and subsequence(before, left) and subsequence(before, right)
                    and subsequence(left, merge.stdout) and subsequence(right, merge.stdout)):
                target, data = self.conflict_copy(name, left, l[name][2], r[name][2])
                copies[name] = (target, data, right)
            else:
                must_preserve[name] = (left, right)
        scratch = self.worktree(f"merge-{attempt}", remote if base == local else local)
        if base not in {local, remote}:
            merge = self.private_git(scratch, "merge", "--no-commit", "--no-ff", remote, check=False)
            if merge.returncode not in {0, 1}:
                raise Stop("merge_failed")
        unresolved = set(names(self.private_git(scratch, "diff", "--name-only", "--diff-filter=U", "-z")))
        unsupported = {p for p in unresolved - set(copies) if not generated_path(p)}
        if unsupported:
            raise Stop("unhandled_conflict", paths=sorted(unsupported))
        staged = set()
        for name, (target, data, right) in copies.items():
            destination = safe_file(scratch, target)
            if destination.exists() and destination.read_bytes() != data:
                raise Stop("conflict_copy_collision", path=target)
            atomic_write(destination, data)
            atomic_write(safe_file(scratch, name), right)
            staged.update((name, target))
            self.copies.add(target)
        self.stage(scratch, staged)
        for name, versions in must_preserve.items():
            actual = safe_file(scratch, name).read_bytes()
            if not all(subsequence(version, actual) for version in versions):
                raise Stop("merge_did_not_preserve_content", path=name)
        # Incoming history must already satisfy the contract. Regeneration is
        # limited to a true merge, whose combined index can legitimately differ.
        merge_head = self.private_git(scratch, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False)
        if merge_head.returncode == 0:
            outputs = self.generated(scratch)
            self.stage(scratch, outputs)
        if self.private_git(scratch, "ls-files", "-u", "-z"):
            raise Stop("unresolved_index")
        self.validate(scratch)
        if merge_head.returncode == 0:
            self.private_git(scratch, "commit", "-m", self.c.merge_message)
        candidate = oid(scratch)
        self.save_ref("candidate-" + str(attempt), candidate)
        self.checkpoint("candidate_ready", candidate=candidate, copies=sorted(self.copies))
        return scratch, candidate

    def fetch(self, attempt):
        self.say(f"מביא את {self.c.branch} מ־{self.c.remote}…")
        target = self.record["ref_prefix"] + f"/remote-{attempt}"
        result = self.g("fetch", "--no-tags", "--no-write-fetch-head", self.c.remote,
                        f"refs/heads/{self.c.branch}:{target}", check=False)
        if result.returncode:
            raise Stop("fetch_failed", status="waiting_remote", returncode=result.returncode)
        remote = oid(self.root, target)
        self.checkpoint("fetched", remote=remote)
        incoming = int(self.g("rev-list", "--count", "HEAD.." + remote).decode().strip() or 0)
        self.say(f"התקבלו {incoming} קומיטים חדשים" if incoming else "אין עדכונים חדשים")
        return remote

    def sync(self, editor_paused=False):
        if self.c.mode != "notes":
            raise Stop("wrong_mode", mode=self.c.mode)
        if self.c.exclusive_worktree is not True or not editor_paused:
            raise Stop("exclusive_paused_editor_required")
        with self.lock():
            try:
                self.say("בודק את העותק…")
                inspection = self.inspect()
                count = len(inspection["files"])
                self.say(f"{count} פתקים מקומיים לשמירה" if count else "אין פתקים מקומיים לשמירה")
                files, index = self.fingerprint(), self.index_bytes()
                before = inspection["head"]
                atomic_write(self.run_dir / "index.before", index)
                before_ref = self.save_ref("before", before)
                self.checkpoint("prepared", before=before, before_ref=before_ref, files=files,
                                selected=inspection["files"])
                local = self.local_commit(inspection, files, index)
                self.save_ref("local", local)
                for attempt in range(self.c.max_attempts):
                    self.idle()
                    files, index = self.fingerprint(), self.index_bytes()
                    local = oid(self.root)
                    remote = self.fetch(attempt)
                    self.say("משלב ובודק בעותק פרטי…")
                    scratch, candidate = self.merge_candidate(local, remote, attempt)
                    self.checkpoint("before_apply", candidate=candidate)
                    self.guard(local, files, index)
                    self.idle()
                    # Git otherwise overwrites ignored, untracked files by
                    # default, including private device settings or drafts.
                    self.g("merge", "--ff-only", "--no-overwrite-ignore", candidate)
                    self.checkpoint("applied", head=candidate)
                    self.say("העותק עודכן")
                    self.g("worktree", "remove", str(scratch))
                    # A new edit is left for the next explicit invocation; a
                    # background writer may not turn this run into its commit.
                    current = self.inspect()
                    if current["files"] or current["head"] != candidate:
                        raise Stop("worktree_changed")
                    log = self.g("log", "--format=%H %s", remote + ".." + candidate).decode().splitlines()
                    push_files, push_index = self.fingerprint(), self.index_bytes()
                    self.checkpoint("before_push", outgoing=log)
                    self.say(f"דוחף {len(log)} קומיטים…" if log else "אין מה לדחוף; מוודא מול השרת…")
                    self.guard(candidate, push_files, push_index)
                    self.idle()
                    result = self.g("push", "--porcelain", self.c.remote,
                                    f"{candidate}:refs/heads/{self.c.branch}", check=False)
                    if result.returncode == 0:
                        self.checkpoint("pushed", head=candidate)
                        self.say("הסתיים")
                        pending = (oid(self.root) != candidate or self.fingerprint() != push_files
                                   or self.index_bytes() != push_index)
                        return {"status": "local_changes_pending" if pending else
                                ("copies_created" if self.copies else "synced"),
                                "head": candidate, "copies": sorted(self.copies),
                                "pushed_commits": len(log), "recovery": str(self.run_dir)}
                    self.checkpoint("push_pending", returncode=result.returncode)
                    self.say(f"השרת לא קיבל את הדחיפה (ניסיון {attempt + 1}/{self.c.max_attempts}); מנסה שוב…")
                raise Stop("push_not_accepted", status="waiting_remote")
            except BaseException as exc:
                self.checkpoint("stopped", last_phase=self.record.get("phase"),
                                reason=exc.result["reason"] if isinstance(exc, Stop) else type(exc).__name__)
                if isinstance(exc, Stop):
                    exc.result["recovery"] = str(self.run_dir)
                raise



class Mirror(Sync):
    """A read-only mirror of the remote branch: fast-forward only, never commit."""

    def local_changes(self):
        """Tracked changes only; untracked files are left alone and never block."""
        changes = []
        for item in self.g("status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=no").split(b"\0"):
            if item:
                changes.append((item[:2].decode(), item[3:].decode()))
        return changes

    def compare(self, name, remote):
        """Where a locally changed file stands against the remote branch."""
        local = self.root / relative_path(name)
        theirs = self.g("cat-file", "-e", f"{remote}:{name}", check=False)
        if theirs.returncode:
            return {"path": name, "on_remote": False}
        remote_data = self.g("show", f"{remote}:{name}")
        local_data = local.read_bytes() if local.is_file() else b""
        remote_lines = set(remote_data.splitlines())
        only_local = [x for x in local_data.splitlines() if x not in remote_lines]
        return {"path": name, "on_remote": True, "same_as_remote": local_data == remote_data,
                "lines_only_local": len(only_local)}

    def status(self):
        self.identity()
        changes = self.local_changes()
        return {"status": "ready" if not changes else "dirty", "mode": "mirror", "head": oid(self.root),
                "changes": [{"path": n, "change": c} for c, n in changes], "network_checked": False}

    def run(self):
        with self.lock():
            try:
                self.idle()
                head = oid(self.root)
                remote = self.fetch(0)
                ahead = int(self.g("rev-list", "--count", remote + "..HEAD").decode().strip() or 0)
                behind = int(self.g("rev-list", "--count", "HEAD.." + remote).decode().strip() or 0)
                changes = self.local_changes()
                if ahead:
                    cherry = self.g("cherry", remote, "HEAD").decode().split()
                    missing = [cherry[i + 1] for i in range(0, len(cherry), 2) if cherry[i] == "+"]
                    raise Stop("diverged", ahead=ahead, behind=behind, not_on_remote_by_patch=missing,
                               changes=[self.compare(n, remote) for _, n in changes])
                if changes:
                    raise Stop("dirty", behind=behind, changes=[self.compare(n, remote) for _, n in changes])
                if not behind:
                    return {"status": "up_to_date", "mode": "mirror", "head": head}
                self.checkpoint("before_apply", head=head, remote=remote)
                self.g("merge", "--ff-only", "--no-overwrite-ignore", remote)
                self.checkpoint("applied", head=remote)
                self.say(f"העץ התקדם ב־{behind} קומיטים")
                return {"status": "updated", "mode": "mirror", "head": remote, "previous": head,
                        "pulled_commits": behind}
            except BaseException as exc:
                self.checkpoint("stopped", last_phase=self.record.get("phase"),
                                reason=exc.result["reason"] if isinstance(exc, Stop) else type(exc).__name__)
                if isinstance(exc, Stop):
                    exc.result["recovery"] = str(self.run_dir)
                raise


class Append(Sync):
    """Move a pending append-only log into a tracked file through a private worktree."""

    def inflight_path(self):
        key = hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        return self.c.state_dir / key / "append-inflight"

    def status(self):
        self.identity()
        pending, inflight = Path(self.c.pending), self.inflight_path()
        count = lambda p: len(p.read_bytes().splitlines()) if p.is_file() else 0
        return {"status": "ready", "mode": "append", "pending_lines": count(pending),
                "inflight_lines": count(inflight), "target": self.c.target, "network_checked": False}

    def take(self):
        """Resume an earlier inflight batch, or atomically take the pending file."""
        inflight, pending = self.inflight_path(), Path(self.c.pending)
        if not inflight.exists():
            if not pending.is_file() or pending.stat().st_size == 0:
                return []
            try:
                os.replace(pending, inflight)
            except OSError as exc:
                raise Stop("pending_not_movable", detail=type(exc).__name__) from exc
        fd = os.open(inflight, os.O_RDWR | os.O_NOFOLLOW)
        try:
            # A writer that opened the pending file before the move holds its lock while it writes.
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = inflight.read_bytes()
        finally:
            os.close(fd)
        lines = [x for x in data.splitlines() if x.strip()]
        if self.c.json_lines:
            for number, line in enumerate(lines, 1):
                try:
                    json.loads(line)
                except ValueError as exc:
                    raise Stop("invalid_json_line", line=number, evidence=str(inflight)) from exc
        return lines

    def run(self):
        with self.lock():
            try:
                self.identity()
                lines = self.take()
                if not lines:
                    return {"status": "nothing_pending", "mode": "append"}
                self.checkpoint("taken", lines=len(lines), inflight=str(self.inflight_path()))
                for attempt in range(self.c.max_attempts):
                    remote = self.fetch(attempt)
                    scratch = self.worktree(f"append-{attempt}", remote)
                    target = safe_file(scratch, self.c.target)
                    existing = target.read_bytes() if target.is_file() else b""
                    present = set(existing.splitlines())
                    new = [x for x in lines if x not in present]
                    if not new:
                        self.g("worktree", "remove", "--force", str(scratch))
                        self.inflight_path().unlink()
                        return {"status": "already_present", "mode": "append", "lines": len(lines)}
                    if existing and not existing.endswith(b"\n"):
                        existing += b"\n"
                    atomic_write(target, existing + b"\n".join(new) + b"\n")
                    self.stage(scratch, [self.c.target])
                    message = self.c.commit_message.replace("{count}", str(len(new)))
                    committed = self.private_git(scratch, "commit", "-m", message, check=False)
                    if committed.returncode:
                        evidence = self.run_dir / "commit-error.txt"
                        atomic_write(evidence, committed.stdout + committed.stderr)
                        raise Stop("commit_failed", evidence=str(evidence))
                    candidate = oid(scratch)
                    self.checkpoint("before_push", candidate=candidate, lines=len(new))
                    result = self.g("push", "--porcelain", self.c.remote,
                                    f"{candidate}:refs/heads/{self.c.branch}", check=False)
                    self.g("worktree", "remove", "--force", str(scratch))
                    if result.returncode == 0:
                        self.inflight_path().unlink()
                        self.checkpoint("pushed", head=candidate)
                        self.say(f"נדחפו {len(new)} שורות")
                        return {"status": "pushed", "mode": "append", "head": candidate, "lines": len(new),
                                "skipped_present": len(lines) - len(new)}
                    self.checkpoint("push_pending", returncode=result.returncode)
                    self.say(f"השרת לא קיבל את הדחיפה (ניסיון {attempt + 1}/{self.c.max_attempts}); מנסה שוב…")
                raise Stop("push_not_accepted", status="waiting_remote")
            except BaseException as exc:
                self.checkpoint("stopped", last_phase=self.record.get("phase"),
                                reason=exc.result["reason"] if isinstance(exc, Stop) else type(exc).__name__)
                if isinstance(exc, Stop):
                    exc.result["recovery"] = str(self.run_dir)
                raise

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["status", "plan", "sync"])
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--editor-paused", action="store_true", help="notes mode: you state that no editor is writing")
    parser.add_argument("--quiet", action="store_true", help="no progress lines on stderr")
    args = parser.parse_args(argv)
    try:
        config = Config.load(args.config)
        runner = {"notes": Sync, "mirror": Mirror, "append": Append}.get(config.mode, Sync)(config)
        if args.command == "sync" and not args.quiet:
            runner.progress = sys.stderr
        if config.mode == "notes":
            result = runner.sync(args.editor_paused) if args.command == "sync" else runner.inspect()
            actions = ["commit_selected_notes", "fetch", "merge_in_private_worktree", "fast_forward", "push"]
        else:
            result = runner.run() if args.command == "sync" else runner.status()
            actions = (["fetch", "fast_forward_only_if_clean"] if config.mode == "mirror" else
                       ["take_pending", "fetch", "append_in_private_worktree", "commit", "push"])
        if args.command == "plan":
            result["actions"] = actions
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except Stop as exc:
        print(json.dumps(exc.result, ensure_ascii=True))
        return 3 if exc.result["status"] in {"busy", "waiting_remote"} else 2
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError) as exc:
        print(json.dumps({"status": "needs_attention", "reason": type(exc).__name__}))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"status": "interrupted", "reason": "run_interrupted"}))
        return 130


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    sys.exit(main())
