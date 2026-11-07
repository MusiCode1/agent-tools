"""בחירת כללים ויצירת תמציות; ללא התקנה או שינוי תצורת משתמש."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

import yaml


class RuleError(ValueError):
    pass


def inside(root, path):
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise RuleError(f"נתיב יוצא מהמאגר: {path}")
    return resolved


def note(path):
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\s*\n(.*?)\n---\s*(?:\n|$)", text, re.S)
    if not match:
        raise RuleError(f"חסר frontmatter: {path}")
    meta = yaml.safe_load(match[1])
    if not isinstance(meta, dict):
        raise RuleError(f"frontmatter אינו mapping: {path}")
    return meta, text[match.end():]


def historical(path, meta):
    return (bool(set(path.parts) & {"history", "archive", "היסטוריה"}) or
            any(meta.get(k) in {"history", "historical", "archived", "superseded", "historical-source"}
                for k in ["kind", "type", "status", "lifecycle", "content_status"]
                if isinstance(meta.get(k), str)))


def validate(meta, path):
    if not isinstance(meta.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*", meta["id"]):
        raise RuleError(f"id חסר/שגוי: {path}")
    if not isinstance(meta.get("title"), str) or not meta["title"].strip() or meta.get("audience") != ["agents"]:
        raise RuleError(f"title/audience חסר/שגוי: {path}")
    flags = meta.get("injection")
    if not isinstance(flags, dict) or set(flags) != {"session", "auto_review"} or any(type(v) is not bool for v in flags.values()):
        raise RuleError(f"נדרשים שני דגלי injection בוליאניים מפורשים: {path}")
    for key in ["summary", "read_when"]:
        if not isinstance(meta.get(key), str) or not meta[key].strip():
            raise RuleError(f"{key} חסר/ריק: {path}")
    if "review_summary" in meta and (not isinstance(meta["review_summary"], str) or not meta["review_summary"].strip()):
        raise RuleError(f"review_summary חסר/שגוי: {path}")
    if "inject" in meta and meta["inject"] is not False and meta["inject"] != "always":
        raise RuleError(f"inject חייב להיות always או false או חסר: {path}")
    if meta.get("inject") is False and any(flags.values()):
        raise RuleError(f"inject:false סותר יעד פעיל: {path}")
    if not isinstance(meta.get("scope"), list):
        raise RuleError(f"scope חייב להיות רשימה מפורשת: {path}")
    if "order" in meta and type(meta["order"]) is not int:
        raise RuleError(f"order חייב להיות מספר שלם: {path}")
    for scope in meta["scope"]:
        if not isinstance(scope, str) or not re.fullmatch(r"(?:machine|project|service):[^/\\:\s]+", scope):
            raise RuleError(f"scope אינו typed: {path}: {scope}")


def load(root, profile):
    root = root.resolve()
    profile = inside(root, profile)
    config = json.loads(profile.read_text())
    if type(config.get("version")) is not int or config["version"] != 1 or not isinstance(config.get("sources"), list) or not config["sources"]:
        raise RuleError("גרסת פרופיל או sources אינם תקינים")
    aliases = config.get("machine_aliases", {})
    if not isinstance(aliases, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not re.fullmatch(r"[^/\\:\s]+", k) or not re.fullmatch(r"[^/\\:\s]+", v) for k, v in aliases.items()):
        raise RuleError("machine_aliases אינו מיפוי שמות תקין")
    if not isinstance(config.get("context", {}), dict) or not isinstance(config.get("context", {}).get("machine", ""), str):
        raise RuleError("context.machine אינו שם מכונה")
    budgets = config.get("budgets", {})
    if not isinstance(budgets, dict) or set(budgets) - {"session", "auto_review"}:
        raise RuleError("budgets מכיל יעד לא מוכר")
    for target, limits in budgets.items():
        if not isinstance(limits, dict) or set(limits) - {"chars", "bytes"} or any(type(v) is not int or v <= 0 for v in limits.values()):
            raise RuleError(f"תקציב לא תקין: {target}")
    rules, seen_paths, seen_ids = [], set(), {}
    for source in config["sources"]:
        if not isinstance(source, str) or not source or Path(source).is_absolute():
            raise RuleError("מקור חייב להיות נתיב יחסי לא ריק")
        base = inside(root, root / source)
        if not base.exists():
            raise RuleError(f"מקור חסר: {source}")
        candidates = [base] if base.is_file() else []
        if base.is_dir():
            for directory, dirs, files in os.walk(base, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in {".git", "__pycache__"} and not (Path(directory) / d).is_symlink())
                candidates.extend(Path(directory) / f for f in sorted(files) if f.endswith(".md"))
        for path in sorted(candidates):
            # תאימות בסימלינק אינה מקור נוסף; escape נדחה גם אם הוא קישור.
            resolved = inside(root, path)
            if path.is_symlink() or resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            meta, body = note(path)
            if historical(path.relative_to(root), meta):
                continue
            validate(meta, path.relative_to(root))
            if meta["id"] in seen_ids:
                raise RuleError(f"id כפול: {meta['id']}: {seen_ids[meta['id']]} / {path}")
            seen_ids[meta["id"]] = path
            rules.append({"path": path.relative_to(root).as_posix(), "meta": meta, "body": body,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return config, sorted(rules, key=lambda r: (r["meta"].get("order", 100), r["meta"]["id"]))


def scopes_for(config, machine, project, services):
    aliases = config.get("machine_aliases", {})
    return ({"machine:" + aliases.get(machine, machine)} if machine else set()) | ({"project:" + project} if project else set()) | {"service:" + s for s in services}


def select(config, rules, scopes, target):
    aliases = config.get("machine_aliases", {})
    result = []
    for rule in rules:
        m = rule["meta"]
        rs = {"machine:" + aliases.get(s[8:], s[8:]) if s.startswith("machine:") else s for s in m["scope"]}
        if m["injection"][target] and m.get("inject") is not False and (m.get("inject") == "always" or rs & scopes):
            result.append(rule)
    return result


def render(root, config, rules, scopes, target, *, references=True, hook=False):
    selected = select(config, rules, scopes, target)
    lines = ["# " + ("הנחיות הסשן" if target == "session" else "מדיניות נוספת למבקר ההרשאות"), ""]
    if target == "auto_review":
        lines += ["בדוק את הפעולה שהוגשה ואת אישורי המשתמש והראיות הזמינים. שמור היתרים קודמים בגבולותיהם; החלטת המבקר אינה מחליפה אישור משתמש שהכלל דורש במפורש. אם חסרה ראיה נדרשת, אין להסיק אישור מטענת המבצע.", ""]
    for rule in selected:
        m = rule["meta"]
        summary = m.get("review_summary", m["summary"]) if target == "auto_review" else m["summary"]
        lines += [f"## {m['id']} — {m['title']}", summary.strip()]
        if references:
            lines += [f"קריאה מלאה: {m['read_when']}. מקור: `{root / rule['path']}`."]
        lines += [""]
    text = "\n".join(lines).rstrip() + "\n"
    limits = config.get("budgets", {}).get(target, {})
    if hook:
        limits = {**limits, "chars": min(limits.get("chars", 9000), 9000)}
    for unit, length in [("chars", len(text)), ("bytes", len(text.encode()))]:
        limit = limits.get(unit)
        if limit is not None and (type(limit) is not int or limit <= 0):
            raise RuleError(f"תקציב {unit} שגוי")
        if limit is not None and length > limit:
            raise RuleError(f"חריגה מתקציב {target}: {length} {unit} > {limit}; אין חיתוך אוטומטי")
    return text, selected


def atomic(path, text):
    if path.is_symlink():
        raise RuleError(f"פלט הוא symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
        try:
            f.write(text)
            tmp = Path(f.name)
        except BaseException:
            Path(f.name).unlink(missing_ok=True)
            raise
    tmp.replace(path)


def build(root, output, config, rules, scopes, check=False):
    output = inside(root, output)
    # מרנדרים ומאמתים הכול לפני כתיבת תוצר כלשהו.
    session, sr = render(root, config, rules, scopes, "session")
    review, rr = render(root, config, rules, scopes, "auto_review")
    artifacts = {"AGENTS.md": session, "auto-review.md": review,
                 "codex-auto-review.toml": "[auto_review]\nextra_policy = " + json.dumps(review, ensure_ascii=False) + "\n",
                 "claude/rules/session.md": session,
                 "cursor/machine-agents.mdc": "---\nalwaysApply: true\n---\n\n" + session}
    if any(scope.startswith("project:") for scope in scopes):
        base_scopes = {scope for scope in scopes if not scope.startswith("project:")}
        base_ids = {r["meta"]["id"] for r in select(config, rules, base_scopes, "session")}
        delta, _ = render(root, config, [r for r in rules if r["meta"]["id"] not in base_ids], scopes, "session")
        artifacts["project/AGENTS.md"] = delta
        artifacts["project/claude-rules/session.md"] = delta
        artifacts["project/cursor-rules/project-agents.mdc"] = "---\nalwaysApply: true\n---\n\n" + delta
    if config.get("trigger_registry"):
        registry = json.loads(inside(root, root / config["trigger_registry"]).read_text())
        by_id = {r["meta"]["id"]: r for r in rules}
        for entry in registry["rules"]:
            source = by_id[entry["id"]]
            entry["text"] = source["meta"]["summary"] + "\nפירוט: " + str(root / source["path"])
        artifacts["rule-triggers.json"] = json.dumps(registry, ensure_ascii=False, indent=2) + "\n"
    manifest = {"version": 1, "scopes": sorted(scopes), "root": str(root), "engine_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "rules": [
        {"id": r["meta"]["id"], "source": r["path"], "sha256": r["sha256"],
         "injection": r["meta"]["injection"], "scope": r["meta"]["scope"],
         "selected": {"session": r in sr, "auto_review": r in rr}} for r in rules],
        "sizes": {k: {"chars": len(v), "bytes": len(v.encode())} for k, v in artifacts.items()}}
    artifacts["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    # בדיקת כל היעדים מראש, לרבות parent symlink.
    paths = {name: inside(root, output / name) for name in artifacts}
    if any((output / name).is_symlink() for name in artifacts):
        raise RuleError("יעד פלט הוא symlink")
    if check:
        for name, path in paths.items():
            if not path.is_file() or path.read_text() != artifacts[name]:
                raise RuleError(f"תוצר חסר/ישן: {path}")
    else:
        for name, path in paths.items():
            atomic(path, artifacts[name])
    return manifest


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["validate", "render", "build", "list", "trigger-registry"])
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--profile", required=True, type=Path)
    p.add_argument("--machine", default="")
    p.add_argument("--project", default="")
    p.add_argument("--service", action="append", default=[])
    p.add_argument("--target", choices=["session", "auto_review"], default="session")
    p.add_argument("--output", type=Path)
    p.add_argument("--check", action="store_true")
    p.add_argument("--hook", action="store_true", help="אכיפת תקרת 9000 תווים; אין חיתוך")
    p.add_argument("--registry", type=Path)
    args = p.parse_args(argv)
    try:
        root = args.root.resolve()
        config, rules = load(root, root / args.profile)
        context = config.get("context", {})
        scopes = scopes_for(config, args.machine or context.get("machine", ""), args.project, args.service)
        if args.command == "validate":
            for target in ["session", "auto_review"]:
                render(root, config, rules, scopes, target)
            print(f"אומתו {len(rules)} כללים")
        elif args.command == "render":
            print(render(root, config, rules, scopes, args.target, hook=args.hook)[0], end="")
        elif args.command == "list":
            print("\n".join(r["path"] for r in select(config, rules, scopes, args.target)))
        elif args.command == "build":
            if not args.output:
                raise RuleError("build דורש --output מפורש בתוך המאגר")
            result = build(root, root / args.output, config, rules, scopes, args.check)
            print(json.dumps(result["sizes"], ensure_ascii=False))
        else:
            if not args.registry:
                raise RuleError("נדרש --registry מפורש")
            registry = json.loads(inside(root, root / args.registry).read_text())
            by_id = {r["meta"]["id"]: r for r in rules}
            for entry in registry["rules"]:
                r = by_id[entry["id"]]
                entry["text"] = r["meta"]["summary"] + "\nפירוט: " + str(root / r["path"])
            print(json.dumps(registry, ensure_ascii=False, indent=2))
        return 0
    except (RuleError, OSError, ValueError, KeyError, yaml.YAMLError) as exc:
        print(f"kb-rules: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
