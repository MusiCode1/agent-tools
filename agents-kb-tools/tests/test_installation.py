import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from kb_tools import installation as install


class InstallationTest(unittest.TestCase):
    def test_preserves_config_multiline_and_root_table_precedence(self):
        before = '# keep\ndeveloper_instructions = """old\npolicy"""\n[auto_review]\npolicy = "base"\nextra_policy = """previous\nrule"""\n[other]\nx = 1\n'
        after = install.toml_values(before, {"project_doc_max_bytes": 131072,
                                           "auto_review.extra_policy": "new\nrule"})
        data = tomllib.loads(after)
        self.assertEqual(data["developer_instructions"], "old\npolicy")
        self.assertEqual(data["auto_review"]["policy"], "base")
        self.assertEqual(data["other"], {"x": 1})
        self.assertIn('# keep', after)
        self.assertEqual(after, install.toml_values(after, {"project_doc_max_bytes": 131072,
                                                           "auto_review.extra_policy": "new\nrule"}))

    def test_reversible_links_and_files_and_change_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = root / "source"
            src.write_text("source")
            target = root / "target"
            target.write_text("original")
            plan = install.Plan()
            plan.link(target, src)
            plan.text(root / "new", "new")
            backup = root / "backup.json"
            plan.apply(backup)
            self.assertTrue(target.is_symlink())
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            (root / "new").write_text("later edit")
            with self.assertRaises(ValueError):
                install.restore(backup)
            self.assertTrue(target.is_symlink())
            (root / "new").write_text("new")
            install.restore(backup)
            self.assertEqual(target.read_text(), "original")
            self.assertFalse((root / "new").exists())

    def test_mid_install_failure_rolls_back_applied_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = root / "a", root / "b"
            a.write_text("a")
            b.write_text("b")
            plan = install.Plan()
            plan.text(a, "changed")
            plan.text(b, "changed")
            real = install.put
            def fail(path, value):
                if Path(path) == b:
                    raise OSError("fixture failure")
                real(path, value)
            with patch.object(install, "put", side_effect=fail):
                with self.assertRaises(OSError):
                    plan.apply(root / "backup.json")
            self.assertEqual(a.read_text(), "a")
            self.assertEqual(b.read_text(), "b")

    def test_plan_detects_intervening_edit_and_refuses_directory_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / "config"
            p.write_text("old")
            plan = install.Plan()
            plan.text(p, "new")
            p.write_text("someone else's work")
            with self.assertRaises(ValueError):
                plan.apply(root / "backup.json")
            self.assertFalse((root / "backup.json").exists())
            with self.assertRaises(ValueError):
                install.Plan().text(root, "no")


if __name__ == "__main__":
    unittest.main()
