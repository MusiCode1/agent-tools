"""SSH client and runner for heavy-run. The runner is a trusted execution account."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading

SCRIPT = sys.argv[1]
PROTOCOL = b"heavy-run/1"
CHUNK = 64 * 1024
HEADER_SIZE = struct.Struct("!Q")
FRAME_SIZE = struct.Struct("!I")
FILES = ("head.bundle", "index", "staged.pack", "worktree.tar")
OBJECT_FORMATS = {"sha1": 40, "sha256": 64}
PRIVATE_NAMES = {
    ".git", ".ssh", ".aws", ".gnupg", ".envrc", ".netrc", ".npmrc", ".pypirc",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
}


class RemoteError(Exception):
    pass


def say(message):
    print(f"heavy-run: {message}", file=sys.stderr, flush=True)


def git(directory, *args, runner=False, **kwargs):
    env = os.environ.copy()
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    if runner:
        env = {key: value for key, value in env.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    return subprocess.run(
        ["git", "-C", str(directory), *args], env=env, check=True, **kwargs
    ).stdout


def git_output(directory, *args, **kwargs):
    return git(directory, *args, stdout=subprocess.PIPE, **kwargs)


def git_line(directory, *args):
    return os.fsdecode(git_output(directory, *args).removesuffix(b"\n"))


def key_for(path):
    return hashlib.sha256(os.fsencode(Path(path).resolve())).hexdigest()


def hex_id(value, length):
    return isinstance(value, str) and len(value) == length and re.fullmatch("[0-9a-f]+", value)


def split_paths(data):
    return data.split(b"\0")[:-1]


def private_path(path):
    for part in path.split("/"):
        part = part.lower()
        if part in PRIVATE_NAMES or part == ".env":
            return True
        if part.startswith(".env.") and part not in {
            ".env.example", ".env.sample", ".env.template",
        }:
            return True
    return False


def validate_path(path):
    if any(part in {"", ".", ".."} for part in path.split("/")) or private_path(path):
        raise RemoteError(f"unsupported snapshot path {path!r}; use --local")


def objects(listing, *, index):
    for record in split_paths(listing):
        fields, path = record.split(b"\t", 1)
        mode, second, third = fields.split()
        if mode == b"160000":
            raise RemoteError("Git submodules require --local")
        validate_path(os.fsdecode(path))
        yield second if index else third


def intent_to_add(root, head):
    args = ("diff", "--cached", "--no-renames", "--no-ext-diff", "--diff-filter=A",
            "--name-only", "-z", head, "--")
    # Git reports intent-to-add entries as additions only when explicitly requested.
    visible = git_output(root, args[0], "--ita-visible-in-index", *args[1:])
    invisible = git_output(root, args[0], "--ita-invisible-in-index", *args[1:])
    return set(split_paths(visible)) - set(split_paths(invisible))


def index_flags(root):
    flags = {"skip-worktree": [], "assume-unchanged": []}
    for entry in split_paths(git_output(root, "ls-files", "-v", "-z")):
        tag, path = entry[:1], os.fsdecode(entry[2:])
        if tag.upper() == b"S":
            flags["skip-worktree"].append(path)
        if tag.islower():
            flags["assume-unchanged"].append(path)
    return flags


def check_symlink(root, name, target):
    if not target or os.path.isabs(target):
        raise RemoteError(f"unsafe symlink {name!r}; use --local")
    try:
        resolved = (root / name).parent.joinpath(target).resolve()
        relative = resolved.relative_to(root)
    except (ValueError, RuntimeError) as error:
        raise RemoteError(f"unsafe symlink {name!r}; use --local") from error
    if private_path(relative.as_posix()):
        raise RemoteError(f"symlink points to a private path {name!r}; use --local")


def archive_path(root, root_fd, name, archive):
    # Open intermediate directories without following symlinks, even if the source changes.
    parts = name.split("/")
    parent = os.dup(root_fd)
    try:
        try:
            for part in parts[:-1]:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = fd
            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        except (FileNotFoundError, NotADirectoryError):
            # Git still lists tracked files that were deleted or replaced by a symlink.
            return False
        entry = tarfile.TarInfo(name)
        entry.mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISLNK(info.st_mode):
            entry.type = tarfile.SYMTYPE
            entry.linkname = os.readlink(parts[-1], dir_fd=parent)
            check_symlink(root, name, entry.linkname)
            archive.addfile(entry)
        elif stat.S_ISREG(info.st_mode):
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(fd, "rb") as source:
                opened = os.fstat(source.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino:
                    raise RemoteError("worktree changed while preparing the snapshot; retry")
                entry.size = opened.st_size
                archive.addfile(entry, source)
                after = os.fstat(source.fileno())
                if (opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
                    raise RemoteError("worktree changed while preparing the snapshot; retry")
        elif stat.S_ISDIR(info.st_mode):
            # Git does not track directories. Their listed children recreate them.
            return False
        else:
            raise RemoteError(f"unsupported file type at {name!r}; use --local")
        return True
    finally:
        os.close(parent)


def snapshot(root, head, package, cached):
    head_tree = git_output(root, "ls-tree", "-rz", head)
    baseline = set(objects(head_tree, index=False))
    index = git_output(root, "ls-files", "--stage", "-z")
    staged = set(objects(index, index=True)) - baseline
    intent = intent_to_add(root, head)
    flags = index_flags(root)
    if not cached:
        git(root, "bundle", "create",
            str(package / FILES[0]), "HEAD", stdout=subprocess.DEVNULL)
    (package / FILES[1]).write_bytes(index)
    if staged:
        with (package / FILES[2]).open("wb") as pack:
            git(root, "pack-objects", "--stdout", input=b"\n".join(sorted(staged)) + b"\n",
                stdout=pack)

    paths = split_paths(git_output(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"))
    present = set()
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with tarfile.open(package / FILES[3], "w", format=tarfile.PAX_FORMAT) as archive:
            for raw_path in sorted(set(paths)):
                name = os.fsdecode(raw_path)
                if private_path(name):
                    continue  # Tracked private paths were rejected with the HEAD/index above.
                validate_path(name)
                if archive_path(root, root_fd, name, archive):
                    present.add(raw_path)
    finally:
        os.close(root_fd)

    if not intent <= present:
        raise RemoteError("deleted intent-to-add files require --local")
    if (git_line(root, "rev-parse", "HEAD") != head
            or git_output(root, "ls-files", "--stage", "-z") != index
            or intent_to_add(root, head) != intent
            or index_flags(root) != flags):
        raise RemoteError("HEAD or index changed while preparing the snapshot; retry")
    return {"intent": [os.fsdecode(path) for path in sorted(intent)], "index_flags": flags}


def destination():
    target = os.environ.get("HEAVY_RUN_REMOTE")
    if target is None:
        try:
            target = os.fsdecode(git_output(Path.cwd(), "config", "--local", "--no-includes", "--get",
                                           "heavy-run.remote", stderr=subprocess.DEVNULL).removesuffix(b"\n"))
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass  # No Git-local setting, or outside a Git repository.
    if target is None:
        config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        try:
            target = (config / "heavy-run" / "remote").read_text().strip()
        except FileNotFoundError:
            return None
    if target and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]*", target):
        raise RemoteError("invalid SSH destination; configure a single SSH host alias")
    return target


def ssh(target, *runner_args):
    # Pass the runner a fixed command and validated ASCII arguments only.
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes",
        "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
        "-o", "StdinNull=no",
        "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
        "--", target, "heavy-run", "--runner", *runner_args,
    ]


def ssh_env():
    # OpenSSH may have SendEnv patterns in the local config.
    return {key: os.environ[key] for key in ("PATH", "HOME", "USER", "LOGNAME")
            if key in os.environ}


def local(arguments):
    os.execv(SCRIPT, [SCRIPT, "--local", *arguments])


def probe(target, repository, head):
    try:
        response = subprocess.run(
            ssh(target, "probe", repository, head), stdin=subprocess.DEVNULL,
            capture_output=True, timeout=8, env=ssh_env(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if response.returncode == 255:
        return None
    if response.returncode or response.stdout not in {PROTOCOL + b" cold\n", PROTOCOL + b" cached\n"}:
        sys.stderr.buffer.write(response.stderr)
        raise RemoteError("SSH runner probe failed; check the runner installation")
    return response.stdout.endswith(b" cached\n")


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise RemoteError("truncated remote protocol stream")
        data.extend(chunk)
    return data


def frame(kind, data):
    output = sys.stdout.buffer
    output.write(kind + FRAME_SIZE.pack(len(data)) + data)
    output.flush()


def send_stdin(stream):
    try:
        with stream:
            with os.fdopen(0, "rb", closefd=False) as source:
                shutil.copyfileobj(source, stream, CHUNK)
    except (BrokenPipeError, OSError):
        pass


def run_remote(target, metadata, package):
    sizes = [(package / name).stat().st_size if (package / name).exists() else 0 for name in FILES]
    header = json.dumps({**metadata, "sizes": sizes}).encode()
    if len(header) > 1024 * 1024:
        raise RemoteError("remote request metadata exceeds 1 MiB")
    # A successful probe is the last point at which fallback is allowed.
    with subprocess.Popen(ssh(target, "run"), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          env=ssh_env()) as process:
        try:
            process.stdin.write(HEADER_SIZE.pack(len(header)) + header)
            for name, size in zip(FILES, sizes):
                if size:
                    with (package / name).open("rb") as source:
                        shutil.copyfileobj(source, process.stdin, CHUNK)
            process.stdin.flush()
        except BrokenPipeError:
            pass
        else:
            # Uploads are framed, so the remaining SSH stdin belongs to the command.
            threading.Thread(target=send_stdin, args=(process.stdin,), daemon=True).start()
        while kind := process.stdout.read(1):
            size, = FRAME_SIZE.unpack(read_exact(process.stdout, FRAME_SIZE.size))
            if size > CHUNK:
                raise RemoteError("invalid remote output frame")
            data = read_exact(process.stdout, size)
            if kind == b"O":
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            elif kind == b"X" and len(data) == 1:
                return data[0]
            else:
                raise RemoteError("invalid remote output frame")
        raise RemoteError(f"remote run ended without a result (SSH exit {process.wait()}); "
                          "the command may have started")


def client(mode, arguments):
    target = destination()
    if not target:
        if mode == "remote":
            raise RemoteError("--remote needs a configured SSH destination")
        local(arguments)
    try:
        root = Path(os.fsdecode(git_output(Path.cwd(), "rev-parse", "--show-toplevel",
                                         stderr=subprocess.DEVNULL).removesuffix(b"\n"))).resolve()
    except subprocess.CalledProcessError:
        if mode == "remote":
            raise RemoteError("--remote needs a Git worktree")
        local(arguments)
    cwd = Path.cwd().relative_to(root).as_posix()
    if cwd != ".":
        validate_path(cwd)
    try:
        head = os.fsdecode(git_output(root, "rev-parse", "--verify", "HEAD",
                                     stderr=subprocess.DEVNULL).removesuffix(b"\n"))
    except subprocess.CalledProcessError as error:
        raise RemoteError("remote execution needs a committed HEAD; use --local") from error
    object_format = git_line(root, "rev-parse", "--show-object-format")
    if object_format not in OBJECT_FORMATS:
        raise RemoteError("unsupported Git object format")
    repository = key_for(git_line(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    worktree = key_for(git_line(root, "rev-parse", "--absolute-git-dir"))
    cached = probe(target, repository, head)
    if cached is None:
        say("SSH runner unavailable; running locally")
        local(arguments)
    branch = subprocess.run(["git", "-C", str(root), "symbolic-ref", "-q", "HEAD"],
                            stdout=subprocess.PIPE, check=False)
    with tempfile.TemporaryDirectory(prefix="heavy-run-upload-") as directory:
        package = Path(directory)
        index_metadata = snapshot(root, head, package, cached)
        return run_remote(target, {
            "protocol": PROTOCOL.decode(), "repository": repository, "worktree": worktree,
            "object_format": object_format, "head": head, "cwd": cwd, "arguments": arguments,
            "branch": os.fsdecode(branch.stdout.removesuffix(b"\n")) or None, **index_metadata,
        }, package)


def runner_status(target):
    if target:
        print("remote queue:", flush=True)
        try:
            subprocess.run(ssh(target, "status"), stdin=subprocess.DEVNULL,
                           env=ssh_env(), timeout=8, check=True)
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
            say("remote queue unavailable")
    return 0


def state_root():
    default = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "heavy-run" / "runner"
    return Path(os.environ.get("HEAVY_RUN_REMOTE_STATE") or default).resolve()


def object_cached(mirror, head):
    ref = mirror / "refs" / "heavy-run" / head
    if not ref.is_file() or ref.read_text().strip() != head:
        return False
    try:
        git(mirror, "cat-file", "-e", f"{head}^{{commit}}", runner=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return False
    return True


def receive(package, stream):
    size, = HEADER_SIZE.unpack(read_exact(stream, HEADER_SIZE.size))
    if size > 1024 * 1024:
        raise RemoteError("remote request metadata exceeds 1 MiB")
    metadata = json.loads(read_exact(stream, size))
    if not isinstance(metadata, dict) or metadata.get("protocol") != PROTOCOL.decode():
        raise RemoteError("incompatible remote protocol")
    for key in ("repository", "worktree"):
        if not hex_id(metadata[key], 64):
            raise RemoteError("invalid repository or worktree identifier")
    if not hex_id(metadata["head"], OBJECT_FORMATS.get(metadata["object_format"], 0)):
        raise RemoteError("invalid commit identifier")
    if metadata["cwd"] != ".":
        validate_path(metadata["cwd"])
    metadata["separator"] = command_separator(metadata["arguments"])
    sizes = metadata["sizes"]
    if len(sizes) != len(FILES) or any(type(n) is not int or n < 0 for n in sizes):
        raise RemoteError("invalid remote payload lengths")
    for name, size in zip(FILES, sizes):
        if size or name == FILES[1]:
            with (package / name).open("wb") as output:
                while size:
                    data = read_exact(stream, min(CHUNK, size))
                    output.write(data)
                    size -= len(data)
    (package / "request.json").write_text(json.dumps(metadata))
    return metadata


def command_separator(arguments):
    if not isinstance(arguments, list) or not all(isinstance(s, str) and "\0" not in s for s in arguments):
        raise RemoteError("invalid command arguments")
    args = iter(enumerate(arguments))
    for index, option in args:
        if option == "--":
            if index + 1 < len(arguments) and arguments[index + 1]:
                return index
            break
        if option in {"--no-queue", "--keep-env"}:
            continue
        if option in {"--label", "--mem-high", "--mem-max", "--swap-max"} and next(args, None) is not None:
            continue
        break
    raise RemoteError("invalid remote heavy-run options or missing command")


def populate_mirror(mirror, head, object_format, bundle):
    mirror.parent.mkdir(parents=True, exist_ok=True)
    with mirror.with_suffix(".lock").open("ab") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (mirror / "HEAD").is_file():
            mirror.mkdir(exist_ok=True)
            git(mirror, "init", "--bare", "--quiet", "--template=", f"--object-format={object_format}", runner=True)
        if not object_cached(mirror, head):
            if not bundle.is_file():
                raise RemoteError("runner lost its cached commit; retry the command")
            refs = git_output(mirror, "bundle", "list-heads", str(bundle), runner=True)
            if refs != os.fsencode(head) + b" HEAD\n":
                raise RemoteError("bundle does not match the requested HEAD")
            git(mirror, "bundle", "unbundle", str(bundle), runner=True, stdout=subprocess.DEVNULL)
            git(mirror, "update-ref", f"refs/heavy-run/{head}", head, runner=True)


def extract_worktree(checkout, archive_path):
    symlinks = []
    with tarfile.open(archive_path, "r:") as archive:
        for member in archive:
            name = member.name
            validate_path(name)
            destination = checkout / name
            parent = checkout
            for part in Path(name).parts[:-1]:
                parent /= part
                if parent.is_symlink():
                    raise RemoteError("snapshot contains a symlink parent")
                parent.mkdir(exist_ok=True)
            if member.issym():
                if not member.linkname or os.path.isabs(member.linkname):
                    raise RemoteError(f"unsafe symlink {name!r}; use --local")
                destination.symlink_to(member.linkname)
                symlinks.append((name, member.linkname))
            elif member.isreg():
                with archive.extractfile(member) as source, destination.open("xb") as target:
                    shutil.copyfileobj(source, target)
                destination.chmod(member.mode & 0o777)
            else:
                raise RemoteError(f"unsupported archive entry {name!r}")
    for name, target in symlinks:
        check_symlink(checkout, name, target)


def bun_inputs(archive_path):
    # Read the submitted files only; cached node_modules contain dependency manifests.
    fingerprint = hashlib.sha256()
    roots = set()
    includes_modules = False
    with tarfile.open(archive_path, "r:") as archive:
        for member in archive:
            path = Path(member.name)
            includes_modules |= "node_modules" in path.parts
            if member.isreg() and path.name in {"bun.lock", "bun.lockb", "package.json", "bunfig.toml"}:
                fingerprint.update(os.fsencode(member.name) + b"\0")
                with archive.extractfile(member) as source:
                    fingerprint.update(hashlib.file_digest(source, "sha256").digest())
                if path.name in {"bun.lock", "bun.lockb"}:
                    roots.add(path.parent)

    if roots:
        fingerprint.update(subprocess.check_output(["bun", "--version"]).strip())
    return sorted(roots), fingerprint.hexdigest(), includes_modules


def prepare(package, checkout, mirror):
    metadata = json.loads((package / "request.json").read_text())
    head, branch = metadata["head"], metadata["branch"]
    populate_mirror(mirror, head, metadata["object_format"], package / FILES[0])
    if checkout.is_symlink():
        raise RemoteError("runner checkout must be a real directory")
    checkout.mkdir(exist_ok=True)
    archive = package / FILES[3]
    roots, fingerprint, includes_modules = bun_inputs(archive)
    marker = checkout.parent / "bun-install"
    reuse_modules = (roots and not includes_modules and marker.is_file()
                     and marker.read_text() == fingerprint
                     and all((checkout / root / "node_modules").is_dir() for root in roots))
    if not reuse_modules:
        marker.unlink(missing_ok=True)
    git_dir = checkout / ".git"
    if git_dir.is_symlink() or git_dir.is_file():
        git_dir.unlink()
    elif git_dir.is_dir():
        shutil.rmtree(git_dir)
    git(checkout, "init", "--quiet", "--template=", f"--object-format={metadata['object_format']}", runner=True)
    # With a fresh empty index, this removes all previous job files except dependency trees.
    keep = ["-e", "node_modules/"] if reuse_modules else []
    git(checkout, "clean", "-ffdx", *keep, "--quiet", runner=True)
    (git_dir / "objects" / "info" / "alternates").write_text(str(mirror / "objects") + "\n")
    git(checkout, "update-ref", "--no-deref", "HEAD", head, runner=True)
    if branch is not None:
        if not branch.startswith("refs/heads/"):
            raise RemoteError("invalid worktree branch")
        git(checkout, "update-ref", branch, head, runner=True)
        git(checkout, "symbolic-ref", "HEAD", branch, runner=True)
    if (package / FILES[2]).is_file():
        with (package / FILES[2]).open("rb") as pack:
            git(checkout, "index-pack", "--stdin", runner=True, stdin=pack, stdout=subprocess.DEVNULL)
    intent = {os.fsencode(path) for path in metadata["intent"]}
    records = []
    for record in split_paths((package / FILES[1]).read_bytes()):
        fields, path = record.split(b"\t", 1)
        mode, oid, stage = fields.split()
        validate_path(os.fsdecode(path))
        if mode not in {b"100644", b"100755", b"120000"} or stage not in {b"0", b"1", b"2", b"3"}:
            raise RemoteError("unsupported index entry")
        if not hex_id(oid.decode(), len(head)):
            raise RemoteError("invalid staged object")
        if path not in intent:
            records.append(record + b"\0")
    if records:
        git(checkout, "update-index", "-z", "--index-info", runner=True, input=b"".join(records))

    extract_worktree(checkout, archive)
    if intent:
        git(checkout, "--literal-pathspecs", "add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul",
            runner=True, input=b"\0".join(sorted(intent)) + b"\0")
    for flag in ("skip-worktree", "assume-unchanged"):
        paths = metadata["index_flags"][flag]
        if paths:
            for path in paths:
                validate_path(path)
            git(checkout, "update-index", f"--{flag}", "-z", "--stdin", runner=True,
                input=b"\0".join(os.fsencode(path) for path in paths) + b"\0")
    cwd = checkout / metadata["cwd"]
    # Empty directories have no Git entries; the invocation directory is still required.
    if not cwd.resolve().is_relative_to(checkout):
        raise RemoteError("working directory escapes the runner checkout")
    cwd.mkdir(parents=True, exist_ok=True)
    if roots and not reuse_modules:
        for root in roots:
            say(f"installing Bun dependencies in {root.as_posix()!r}")
            subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=checkout / root,
                           stdout=sys.stderr, check=True)
        marker.write_text(fingerprint)
    command = metadata["arguments"][metadata["separator"] + 1:]
    os.chdir(cwd)
    os.execvp("env", ["env", *command])


def serve_run():
    state = state_root()
    state.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="upload-", dir=state) as directory:
        package = Path(directory)
        # Use the unbuffered standard input to avoid consuming command stdin during upload.
        with os.fdopen(0, "rb", buffering=0, closefd=False) as stream:
            metadata = receive(package, stream)
        worktree = state / "worktrees" / metadata["worktree"]
        worktree.mkdir(parents=True, exist_ok=True)
        checkout = worktree / "checkout"
        mirror = state / "git" / (metadata["repository"] + ".git")
        with (worktree / "checkout.lock").open("ab") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                say("waiting for the runner checkout")
                fcntl.flock(lock, fcntl.LOCK_EX)
            args = metadata["arguments"]
            separator = metadata["separator"]
            label = Path(args[separator + 1]).name
            command = [SCRIPT, "--local", "--label", label, *args[:separator], "--",
                       sys.executable, "-I", __file__, SCRIPT, "prepare", str(package),
                       str(checkout), str(mirror)]
            with subprocess.Popen(command, cwd=worktree, stdout=subprocess.PIPE,
                                  pass_fds=(lock.fileno(),)) as process:
                connected = True
                while data := process.stdout.read1(CHUNK):
                    if connected:
                        try:
                            frame(b"O", data)
                        except BrokenPipeError:
                            connected = False
                status = process.wait()
                fcntl.flock(lock, fcntl.LOCK_UN)
                if connected:
                    frame(b"X", bytes([status if status >= 0 else 128 - status]))
    return 0


def runner(arguments):
    operation, *options = arguments
    if operation == "status" and not options:
        os.execv(SCRIPT, [SCRIPT, "status", "--local"])
    if operation == "probe":
        if not options:
            print(PROTOCOL.decode())
            return 0
        if len(options) != 2 or not hex_id(options[0], 64) or not any(
                hex_id(options[1], length) for length in OBJECT_FORMATS.values()):
            raise RemoteError("invalid runner probe")
        mirror = state_root() / "git" / (options[0] + ".git")
        result = "cached" if object_cached(mirror, options[1]) else "cold"
        print(PROTOCOL.decode(), result)
        return 0
    if operation == "run" and not options:
        return serve_run()
    raise RemoteError("unknown runner operation")


def main(action, *args):
    if action == "client":
        return client(args[0], list(args[1:]))
    if action == "status":
        return runner_status(destination())
    os.umask(0o077)
    if action == "runner":
        return runner(list(args))
    if action == "prepare":
        return prepare(*(Path(value) for value in args))
    raise RemoteError("unknown remote helper operation")


if __name__ == "__main__":
    try:
        sys.exit(main(*sys.argv[2:]))
    except (RemoteError, OSError, ValueError, KeyError, TypeError,
            subprocess.CalledProcessError, tarfile.TarError) as error:
        say(str(error))
        sys.exit(125)
