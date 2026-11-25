import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
ENGLISH = "This response has enough ordinary words to exceed the minimum letter count."
HEBREW = "התשובה הזאת כתובה בעברית ויש בה מספיק מילים כדי לעבור את סף האותיות."
ARABIC = "هذه الإجابة مكتوبة باللغة العربية وتحتوي على كلمات كافية لتجاوز الحد الأدنى."


class GateTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {
            "HOME": str(self.root / "home"),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "PATH": str(Path(sys.executable).parent),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def hook(self, message=ENGLISH, *, raw=None, **fields):
        payload = {
            "hook_event_name": "Stop",
            "session_id": "example",
            "last_assistant_message": message,
            **fields,
        }
        result = subprocess.run(
            [sys.executable, str(HERE / "gate.py")],
            env=self.env, input=json.dumps(payload) if raw is None else raw,
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout) if result.stdout else None

    def cli(self, *args):
        return subprocess.run(
            [str(HERE / "reply-language-gate"), *args],
            env=self.env, capture_output=True, text=True,
        )

    def configure(self, **config):
        path = self.root / "config" / "reply-language-gate" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(config), encoding="utf-8")

    def events(self):
        path = self.root / "cache" / "reply-language-gate.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_hebrew(self):
        self.assertIsNone(self.hook(HEBREW))

    def test_english_blocks(self):
        self.assertEqual(self.hook()["decision"], "block")
        event, = self.events()
        self.assertEqual(set(event), {"event", "ts", "session_id", "ratio"})
        self.assertEqual((event["event"], event["ratio"]), ("block", 0))

    def test_technical_text_skipped(self):
        self.assertIsNone(self.hook(
            f"הנה קוד:\n```python\n{ENGLISH}\n```\n"
            f"~~~\n{ENGLISH}\n~~~\n`{ENGLISH}` https://example.test/long-english-path "
            "[דוגמה](https://example.test/another-long-path) "
            "~/many/english/letters/that/should/not/count"
        ))

    def test_short_reply(self):
        self.assertIsNone(self.hook("Short reply."))

    def test_allow_check_list_and_revoke(self):
        self.env["CLAUDE_CODE_SESSION_ID"] = "example"
        self.assertEqual(self.cli("check").returncode, 1)
        self.assertEqual(self.cli("allow", "--reason", "Please answer in English.").returncode, 0)
        self.assertEqual(self.cli("check").returncode, 0)
        self.assertEqual(json.loads(self.cli("list").stdout)["session_id"], "example")
        self.assertIsNone(self.hook())
        self.assertEqual(self.events()[-1]["event"], "skip-allowed")
        self.assertEqual(self.cli("revoke", "--session", "example").returncode, 0)
        self.assertEqual(self.hook()["decision"], "block")

    def test_required_cli_inputs(self):
        self.assertIn("--reason", self.cli("allow").stderr)
        result = self.cli("allow", "--reason", "Please answer in English.")
        self.assertEqual(result.returncode, 2)
        self.assertIn("CLAUDE_CODE_SESSION_ID", result.stderr)

    def test_expiry(self):
        path = self.root / "state" / "reply-language-gate" / "allow.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({
            "session_id": "example", "ts": time.time() - 31 * 86400, "reason": "Old request"
        }) + "\n")
        self.assertEqual(self.cli("check", "--session", "example").returncode, 1)
        self.assertEqual(self.hook()["decision"], "block")
        self.assertEqual(self.cli("allow", "--session", "fresh", "--reason", "New request").returncode, 0)
        self.assertEqual(json.loads(path.read_text())["session_id"], "fresh")

    def test_loop_guard(self):
        self.assertEqual(set(self.hook(stop_hook_active=True)), {"systemMessage"})
        self.assertEqual(self.events()[-1]["event"], "loop-warn")

    def test_invalid_input_fails_open(self):
        self.assertIsNone(self.hook(raw="{"))
        self.assertEqual(self.events()[-1]["event"], "error")

    def test_custom_template(self):
        self.configure(message="{language}|{ratio}|{session_id}|{allow_cmd}")
        identifier = "session ' with spaces"
        language, ratio, session, command = self.hook(session_id=identifier)["reason"].split("|")
        self.assertEqual((language, ratio, session), ("עברית", "0%", identifier))
        self.assertEqual(shlex.split(command), [
            "reply-language-gate", "allow", f"--session={identifier}", "--reason", "<ציטוט>"
        ])

    def test_unknown_placeholder_falls_back(self):
        self.configure(message="{unknown}")
        self.assertIn("כתוב מחדש", self.hook()["reason"])
        self.assertEqual([event["event"] for event in self.events()], ["error", "block"])

    def test_arabic(self):
        self.configure(language="arabic")
        self.assertIsNone(self.hook(ARABIC))
        self.assertIn("العربية", self.hook()["reason"])

    def test_environment_overrides_config(self):
        self.configure(language="arabic", min_ratio=0, min_letters=400, message="from file")
        self.env.update(REPLY_LANG="hebrew", REPLY_LANG_MIN_RATIO="0.6",
                        REPLY_LANG_MIN_LETTERS="40", REPLY_LANG_MESSAGE="{language} from env")
        self.assertIsNone(self.hook(HEBREW))
        self.assertEqual(self.hook()["reason"], "עברית from env")

    def test_transcript_fallback_and_direct_message_precedence(self):
        transcript = self.root / "transcript.jsonl"
        transcript.write_text("\n".join([
            "corrupt line",
            json.dumps({"type": "assistant", "message": {"content": HEBREW}}),
            json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": ENGLISH}, {"type": "tool_use", "text": HEBREW},
            ]}}),
            json.dumps({"type": "user", "message": {"content": HEBREW}}),
        ]))
        self.assertEqual(self.hook(None, transcript_path=str(transcript))["decision"], "block")
        self.assertIsNone(self.hook(HEBREW, transcript_path=str(transcript)))

    def test_subagent_stop_ignored(self):
        self.assertIsNone(self.hook(hook_event_name="SubagentStop"))


if __name__ == "__main__":
    unittest.main()
