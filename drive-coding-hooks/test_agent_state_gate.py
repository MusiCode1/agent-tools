#!/usr/bin/env python3
"""Tests for agent_state_gate against a fake drive-coding backend."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "agent_state_gate.py"
AGENT = "11111111-2222-3333-4444-555555555555"
AGENTS = {}


class Backend(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = self.path.strip("/").split("/")
        agent = AGENTS.get(parts[2]) if len(parts) >= 3 else None
        if agent is None:
            self.send_response(404); self.end_headers(); return
        body = agent["state"] if parts[-1] == "state" else {"agent": {"id": parts[2], "cliKind": agent["cli"]}}
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class GateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Backend)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        AGENTS.clear()

    def agent(self, cli="claude", mode="default", pending=None):
        AGENTS[AGENT] = {"cli": cli, "state": {"turnState": "idle", "modes": {"currentModeId": mode},
                                               "pending": {"permission": pending}}}

    def run_gate(self, payload, bases=None):
        env = dict(os.environ, HOME=self.home.name, DRIVE_CODING_GATE_BASES=bases or self.base)
        out = subprocess.run([sys.executable, "-I", str(SCRIPT)], input=json.dumps(payload),
                             capture_output=True, text=True, env=env, timeout=20)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def send(self, **extra):
        args = {"agent": AGENT, "prompt": "hi"}
        args.update(extra)
        return {"hook_event_name": "PreToolUse", "session_id": "s1",
                "tool_name": "mcp__drive-coding__session_send", "tool_input": args}

    def test_pending_permission_denies_send(self):
        self.agent(mode="bypassPermissions", pending={"requestId": "r1", "toolCall": {"title": "Bash"}})
        out = self.run_gate(self.send())
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("ממתין לאישור הרשאה (Bash)", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_manual_claude_mode_warns_once(self):
        self.agent(mode="default")
        first = self.run_gate(self.send())
        self.assertIn("'default'", first["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("permissionDecision", first["hookSpecificOutput"])
        self.assertEqual(self.run_gate(self.send()), {"continue": True})

    def test_unreported_claude_mode_warns(self):
        self.agent(mode=None)
        AGENTS[AGENT]["state"]["modes"] = None
        out = self.run_gate(self.send())
        self.assertIn("לא דיווח על מצב הרשאות", out["hookSpecificOutput"]["additionalContext"])

    def test_mode_change_in_same_call_skips_warning(self):
        self.agent(mode="default")
        self.assertEqual(self.run_gate(self.send(sets={"mode": "bypassPermissions"})), {"continue": True})

    def test_bypass_and_non_claude_pass_silently(self):
        self.agent(mode="bypassPermissions")
        self.assertEqual(self.run_gate(self.send()), {"continue": True})
        self.agent(cli="codex", mode="read-only")
        self.assertEqual(self.run_gate(self.send()), {"continue": True})

    def test_curl_rpc_prompt_is_checked_against_its_own_base(self):
        self.agent(pending={"requestId": "r2"})
        cmd = f"curl -s -X POST {self.base}/api/agents/{AGENT}/rpc -d '{{\"method\":\"session/prompt\"}}'"
        out = self.run_gate({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}},
                            bases="http://127.0.0.1:9")
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        cmd_state = f"curl -s {self.base}/api/agents/{AGENT}/state"
        self.assertEqual(self.run_gate({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                                        "tool_input": {"command": cmd_state}}), {"continue": True})

    def test_open_reports_mode(self):
        self.agent(mode="default")
        response = [{"type": "text", "text": json.dumps({"agent": AGENT, "sessionId": "x"})}]
        out = self.run_gate({"hook_event_name": "PostToolUse", "session_id": "s2",
                             "tool_name": "mcp__drive-coding__session_open", "tool_input": {"cli": "claude"},
                             "tool_response": response})
        self.assertIn("נפתח במצב ההרשאות 'default'", out["hookSpecificOutput"]["additionalContext"])

    def test_cursor_before_mcp_denies_on_pending(self):
        self.agent(pending={"requestId": "r3"})
        payload = {"hook_event_name": "beforeMCPExecution", "tool_name": "session_send",
                   "mcp_server_name": "drive-coding", "tool_input": json.dumps({"agent": AGENT, "prompt": "x"})}
        self.assertEqual(self.run_gate(payload)["permission"], "deny")
        AGENTS[AGENT]["state"]["pending"]["permission"] = None
        self.assertEqual(self.run_gate(payload), {"permission": "allow"})

    def test_unknown_agent_and_unreachable_backend_fail_open(self):
        self.assertEqual(self.run_gate(self.send()), {"continue": True})
        self.assertEqual(self.run_gate(self.send(), bases="http://127.0.0.1:9"), {"continue": True})
        out = subprocess.run([sys.executable, "-I", str(SCRIPT)], input="not json", capture_output=True,
                             text=True, env=dict(os.environ, HOME=self.home.name), timeout=20)
        self.assertEqual((out.returncode, json.loads(out.stdout)), (0, {"continue": True}))


if __name__ == "__main__":
    unittest.main()
