"""Explicit, reversible file installation. No installation happens on import."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import tomllib


def state(path):
    path = Path(path)
    if path.is_symlink():
        return {"kind": "link", "target": os.readlink(path)}
    if not path.exists():
        return {"kind": "absent"}
    if not path.is_file():
        raise ValueError(f"Refusing to replace a directory: {path}")
    return {"kind": "file", "data": base64.b64encode(path.read_bytes()).decode(),
            "mode": stat.S_IMODE(path.stat().st_mode)}


def put(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if value["kind"] == "absent":
        if path.exists() or path.is_symlink():
            path.unlink()
        return
    fd, tmp = tempfile.mkstemp(prefix=".kb-install-", dir=path.parent)
    os.close(fd)
    try:
        if value["kind"] == "link":
            os.unlink(tmp)
            os.symlink(value["target"], tmp)
        else:
            Path(tmp).write_bytes(base64.b64decode(value["data"]))
            os.chmod(tmp, value["mode"])
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


class Plan:
    def __init__(self):
        self.changes = {}

    def _set(self, path, value):
        # Resolve parents, never the final symlink that we intend to replace.
        path = Path(path).absolute()
        path = path.parent.resolve() / path.name
        before = state(path)
        if before == value:
            return
        if str(path) in self.changes:
            raise ValueError(f"Duplicate installation destination: {path}")
        self.changes[str(path)] = {"before": before, "after": value}

    def text(self, path, text):
        before = state(path)
        mode = before.get("mode", 0o600)
        self._set(path, {"kind": "file", "data": base64.b64encode(text.encode()).decode(), "mode": mode})

    def link(self, path, target):
        target = Path(target).absolute()
        if not target.exists():
            raise ValueError(f"Missing installation source: {target}")
        self._set(path, {"kind": "link", "target": str(target)})

    def remove(self, path):
        self._set(path, {"kind": "absent"})

    def apply(self, backup):
        backup = Path(backup)
        if backup.exists():
            raise ValueError("Backup already exists; refusing to overwrite")
        for name, change in self.changes.items():
            if state(name) != change["before"]:
                raise ValueError(f"Installation target changed since planning: {name}")
        backup.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"version": 1, "changes": self.changes}, f, indent=2)
            f.write("\n")
        applied = []
        try:
            for name, change in self.changes.items():
                put(name, change["after"])
                applied.append(name)
        except BaseException:
            for name in reversed(applied):
                put(name, self.changes[name]["before"])
            raise


def restore(backup):
    data = json.loads(Path(backup).read_text())
    if data.get("version") != 1:
        raise ValueError("Unsupported backup version")
    for name, change in data["changes"].items():
        if state(name) != change["after"]:
            raise ValueError(f"Target changed after installation; inspect before restoring: {name}")
    for name, change in reversed(list(data["changes"].items())):
        put(name, change["before"])


def toml_values(text, values):
    """Change only explicit string/integer keys, preserving all other config text."""
    original = tomllib.loads(text)
    lines = text.splitlines(keepends=True)
    def key_parts(dotted):
        node = tomllib.loads(dotted + " = 0")
        parts = []
        while isinstance(node, dict):
            key, node = next(iter(node.items()))
            parts.append(key)
        return parts

    for dotted, value in values.items():
        table, _, key = dotted.rpartition(".")
        parts = key_parts(dotted)
        current = original
        for part in parts[:-1]:
            current = current.get(part, {})
        if current.get(key) == value:
            continue
        section = ""
        found = False
        import re
        for i, line in enumerate(lines):
            header = re.match(r"\s*\[([^\[\]]+)\]\s*(?:#.*)?$", line)
            if header:
                section = header[1]
            if section != table or not re.match(r"\s*" + re.escape(key) + r"\s*=", line):
                continue
            end = i + 1
            rhs = line.split("=", 1)[1].lstrip()
            if rhs.startswith(('"""', "'''")):
                quote = rhs[:3]
                if quote not in rhs[3:]:
                    while end < len(lines) and quote not in lines[end]:
                        end += 1
                    if end == len(lines):
                        raise ValueError("Unclosed multiline TOML value")
                    end += 1
            lines[i:end] = [key + " = " + json.dumps(value, ensure_ascii=False) + "\n"]
            found = True
            break
        if not found:
            section = ""
            pos = len(lines)
            for i, line in enumerate(lines):
                m = re.match(r"\s*\[([^\[\]]+)\]", line)
                if m:
                    if section == table:
                        pos = i
                        break
                    section = m[1]
            if table and section != table:
                lines += ["\n[" + table + "]\n"]
                pos = len(lines)
            lines[pos:pos] = [key + " = " + json.dumps(value, ensure_ascii=False) + "\n"]
    result = "".join(lines)
    parsed = tomllib.loads(result)
    for dotted, value in values.items():
        node = parsed
        for part in key_parts(dotted):
            node = node[part]
        if node != value:
            raise ValueError(f"TOML update failed: {dotted}")
    return result
