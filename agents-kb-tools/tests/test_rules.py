import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE / "src"))
from kb_tools.rules import RuleError, build, load, render, scopes_for, select


class RulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="כללים עם רווחים ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.config = {"version": 1, "sources": ["rules"], "machine_aliases": {"oldbox": "box"},
                       "context": {"machine": "box"}, "budgets": {"session": {"bytes": 30000}, "auto_review": {"chars": 12000}}}
        self.profile = self.root / "profile.json"
        self.save_profile()
        self.rule("rules/one.md", "one", ["machine:box"], True, True,
                  summary="אישור קיים תקף בגבולותיו", review_summary="שמור היתר קודם; מיזוג נדרש לאישור ייעודי")
        self.rule("rules/two.md", "two", ["project:demo"], True, False)
        self.rule("rules/service.md", "service", ["service:mail"], True, True)
        self.rule("rules/empty.md", "empty", [], True, True)
        self.rule("rules/always.md", "always", [], True, False, inject="always")
        self.rule("rules/off.md", "off", ["machine:box"], False, False, inject=False)

    def save_profile(self):
        self.profile.write_text(json.dumps(self.config))

    def rule(self, rel, id, scope, session, review, **extra):
        meta = {"id": id, "title": id, "audience": ["agents"], "scope": scope,
                "injection": {"session": session, "auto_review": review},
                "summary": "תמצית " + id, "read_when": "לפני הפעולה", **extra}
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("---\n" + yaml.safe_dump(meta, allow_unicode=True) + "---\n\nUNIQUE_FULL_BODY_" + id + "\n")
        return p

    def loaded(self):
        return load(self.root, self.profile)

    def test_scope_alias_project_service_and_independent_targets(self):
        c, rs = self.loaded()
        scopes = scopes_for(c, "oldbox", "demo", [])
        self.assertEqual({r["meta"]["id"] for r in select(c, rs, scopes, "session")}, {"one", "two", "always"})
        self.assertEqual({r["meta"]["id"] for r in select(c, rs, scopes, "auto_review")}, {"one"})
        self.assertIn("service", {r["meta"]["id"] for r in select(c, rs, scopes_for(c, "box", "", ["mail"]), "auto_review")})

    def test_full_body_never_falls_back_and_policy_keeps_authorization_conditions(self):
        c, rs = self.loaded()
        text, _ = render(self.root, c, rs, {"machine:box"}, "auto_review")
        self.assertIn("שמור היתר קודם", text)
        self.assertIn("מיזוג נדרש לאישור ייעודי", text)
        self.assertIn(str(self.root / "rules/one.md"), text)
        self.assertNotIn("UNIQUE_FULL_BODY", text)
        self.assertNotIn("## two", text)

    def test_missing_summary_or_flags_and_duplicate_id_fail(self):
        p = self.root / "rules/one.md"
        original = p.read_text()
        for key in ["summary", "injection", "scope", "read_when"]:
            from kb_tools.rules import note
            meta, body = note(p)
            del meta[key]
            p.write_text("---\n" + yaml.safe_dump(meta) + "---\n" + body)
            with self.assertRaises(RuleError): self.loaded()
            p.write_text(original)
        self.rule("rules/duplicate.md", "one", [], False, False)
        with self.assertRaises(RuleError): self.loaded()

    def test_history_even_always_is_excluded_and_alias_not_duplicated(self):
        self.rule("rules/היסטוריה/old.md", "one", [], True, True, inject="always")
        self.rule("rules/metadata.md", "one", [], True, True, lifecycle="history", inject="always")
        (self.root / "rules/alias.md").symlink_to("one.md")
        c, rs = self.loaded()
        self.assertEqual(len(rs), 6)

    def test_escape_source_and_output_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            (self.root / "rules/escape.md").symlink_to(Path(outside) / "private.md")
            with self.assertRaises(RuleError): self.loaded()
            (self.root / "rules/escape.md").unlink()
            c, rs = self.loaded()
            (self.root / "out").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(RuleError): build(self.root, self.root / "out", c, rs, {"machine:box"})
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_budget_failure_writes_nothing_and_hook_does_not_truncate(self):
        c, rs = self.loaded()
        c["budgets"]["auto_review"]["chars"] = 1
        with self.assertRaises(RuleError): build(self.root, self.root / "generated", c, rs, {"machine:box"})
        self.assertFalse((self.root / "generated").exists())
        c["budgets"]["auto_review"]["chars"] = 30000
        rs[0]["meta"]["summary"] = "א" * 10000
        with self.assertRaises(RuleError): render(self.root, c, rs, {"machine:box"}, "session", hook=True)

    def test_reference_root_reproduces_artifacts_from_isolated_snapshot(self):
        import shutil
        c, rs = self.loaded()
        canonical = Path('/canonical/instance')
        output = self.root / 'generated'
        build(self.root, output, c, rs, {'machine:box'}, reference_root=canonical)
        self.assertIn(str(canonical / 'rules/one.md'), (output / 'AGENTS.md').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp)
            shutil.copytree(self.root, snapshot, dirs_exist_ok=True)
            copied_config, copied_rules = load(snapshot, snapshot / 'profile.json')
            build(snapshot, snapshot / 'generated', copied_config, copied_rules, {'machine:box'},
                  check=True, reference_root=canonical)

    def test_build_check_is_read_only_and_detects_changes(self):
        c, rs = self.loaded()
        out = self.root / "generated"
        result = build(self.root, out, c, rs, {"machine:box"})
        before = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}
        build(self.root, out, c, rs, {"machine:box"}, True)
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual({r["id"] for r in result["rules"] if r["selected"]["auto_review"]}, {"one"})
        (out / "AGENTS.md").write_text("stale")
        with self.assertRaises(RuleError): build(self.root, out, c, rs, {"machine:box"}, True)
        self.assertEqual((out / "AGENTS.md").read_text(), "stale")

    def test_invalid_profile_and_string_booleans_fail(self):
        for key, value in [("sources", ["/outside"]), ("machine_aliases", []), ("budgets", {"session": {"bytes": "3000"}}), ("context", {"machine": []})]:
            original = self.config.copy()
            self.config[key] = value
            self.save_profile()
            with self.assertRaises(RuleError): self.loaded()
            self.config = original
            self.save_profile()
        self.rule("rules/typed.md", "typed", [], "true", False)
        with self.assertRaises(RuleError): self.loaded()

    def test_native_adapters_and_toml_additive_policy_roundtrip(self):
        import tomllib
        c, rs = self.loaded()
        out = self.root / "generated"
        build(self.root, out, c, rs, {"machine:box"})
        cfg = tomllib.loads((out / "codex-auto-review.toml").read_text())
        self.assertEqual(set(cfg["auto_review"]), {"extra_policy"})
        self.assertEqual(cfg["auto_review"]["extra_policy"], (out / "auto-review.md").read_text())
        self.assertEqual((out / "AGENTS.md").read_bytes(), (out / "claude/rules/session.md").read_bytes())
        self.assertTrue((out / "cursor/machine-agents.mdc").read_text().startswith("---\nalwaysApply: true"))
        # רשומת Git שומרת regex/paths, אבל הטקסט נלקח מהמקור הנוכחי.
        (self.root / "registry.json").write_text(json.dumps({"rules": [{"id": "one", "trigger": "git", "paths": ["one.md"], "text": "STALE"}]}))
        c["trigger_registry"] = "registry.json"
        build(self.root, out, c, rs, {"machine:box"})
        entry = json.loads((out / "rule-triggers.json").read_text())["rules"][0]
        self.assertNotIn("STALE", entry["text"])
        self.assertIn("אישור קיים", entry["text"])
        self.assertEqual(entry["paths"], ["one.md"])
        build(self.root, out, c, rs, {"machine:box", "project:demo"})
        delta = (out / "project/AGENTS.md").read_text()
        self.assertIn("## two", delta)
        self.assertNotIn("## one", delta)
        self.assertNotIn("## always", delta)

    def test_cli_explicit_root_ignores_foreign_cwd_and_env(self):
        import os
        env = {**os.environ, "KB_ROOT": "/no/such/instance", "MACHINE": "/foreign"}
        r = subprocess.run([sys.executable, str(SOURCE / "bin/kb-rules"), "render", "--root", str(self.root),
                            "--profile", "profile.json", "--machine", "oldbox"], cwd="/tmp", env=env, text=True, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("## one", r.stdout)
        self.assertNotIn("UNIQUE_FULL_BODY", r.stdout)
        result = subprocess.run(["bash", str(SOURCE / "bin/kb-build-agents"), "--root", str(self.root),
                                 "--profile", "profile.json", "--output", "wrapper-output"],
                                cwd="/tmp", env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "wrapper-output/manifest.json").is_file())


if __name__ == "__main__": unittest.main()
