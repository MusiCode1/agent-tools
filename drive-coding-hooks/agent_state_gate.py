#!/usr/bin/env python3
"""Agent-state gate for drive-coding children — check a child's permission state
before prompting it, and report its mode right after opening it.

Why: a child opened with a permission policy can still come up in a manual mode
(the backend may not store the requested policy). It then stops on its first
tool call and waits for a human, while `turnState` looks like an ended turn.
A parent that keeps sending prompts pushes them into an open turn and reads an
empty answer as final.

Events (one script, wired per CLI):
  PreToolUse  mcp__drive-coding__session_send        → check the target agent
  PreToolUse  Bash with curl …/api/agents/<id>/rpc + session/prompt → same check
  PostToolUse mcp__drive-coding__session_open        → report the opened mode
  Cursor beforeMCPExecution (server drive-coding)    → deny on pending permission

Decisions:
  pending.permission is set     → deny: the turn is waiting for a human answer.
  claude child not in bypassPermissions, and the call does not change the mode
                                → allow with a one-time warning per agent.
  anything else, or any error   → allow silently (fail-open, never wedge a fleet).

Backends: DRIVE_CODING_GATE_BASES (comma-separated) or the local defaults
127.0.0.1:4000-4002. A curl command that names its base URL is checked against
that URL. Calls that go to a remote machine (ssh …) are not visible here.

Reads the hook JSON on stdin, answers on stdout, always exits 0.
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

DEFAULT_BASES = "http://127.0.0.1:4000,http://127.0.0.1:4001,http://127.0.0.1:4002"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
RPC_URL = re.compile(r"(https?://(?:127\.0\.0\.1|localhost)(?::\d+)?)/api/agents/(" + UUID + r")/rpc")
BYPASS_MODE = {"claude": "bypassPermissions"}
LOG = Path(os.path.expanduser("~/.cache/drive-coding-agent-state-gate.jsonl"))
STATE_DIR = Path(os.path.expanduser("~/.cache/drive-coding-agent-state-gate"))


def log(record):
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def bases():
    raw = os.environ.get("DRIVE_CODING_GATE_BASES") or DEFAULT_BASES
    return [b.strip().rstrip("/") for b in raw.split(",") if b.strip()]


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=3) as resp:
        return json.load(resp)


def lookup(agent_id, base=None):
    """Return (state, cli_kind) from the first backend that knows the agent."""
    for b in ([base] if base else bases()):
        try:
            state = fetch_json(f"{b}/api/agents/{agent_id}/state")
        except Exception:
            continue
        cli = None
        try:
            cli = (fetch_json(f"{b}/api/agents/{agent_id}").get("agent") or {}).get("cliKind")
        except Exception:
            pass
        return state, (cli or "").lower() or None
    return None, None


def parse_input(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return {}
    return value if isinstance(value, dict) else {}


def pending_reason(agent_id, state):
    pending = ((state or {}).get("pending") or {}).get("permission")
    if not pending:
        return None
    title = ""
    if isinstance(pending, dict):
        call = pending.get("toolCall") or {}
        title = call.get("title") or call.get("kind") or pending.get("title") or ""
    what = f" ({title})" if title else ""
    return (f"הסוכן {agent_id} ממתין לאישור הרשאה{what}, ולכן התור שלו עוד לא הסתיים. "
            "אל תשלח פרומפט נוסף ואל תקרא את התשובה כסופית: ענה על ההרשאה, "
            "או בקש מהמשתמש לשחרר אותה, ואז המתן ל-turnState=idle.")


def mode_warning(agent_id, state, cli):
    mode = ((state or {}).get("modes") or {}).get("currentModeId")
    want = BYPASS_MODE.get(cli or "")
    if not want or not mode or mode == want:
        return None
    return (f"הסוכן {agent_id} ({cli}) במצב ההרשאות '{mode}', לא '{want}': כל כלי שידרוש "
            "אישור ימתין לאישור ידני. אם המשימה צריכה לרוץ בלי עצירה, העבר מצב "
            "(session_send.sets או session/set_mode) או בקש מהמשתמש; אם המצב הידני מכוון, המשך.")


def warn_once(session_id, agent_id):
    """True the first time this session warns about this agent."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        marker = STATE_DIR / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', session_id or 'nosession')}--{agent_id}"
        if marker.exists():
            return False
        marker.write_text("")
        return True
    except Exception:
        return True


def out_allow(event, context=None):
    if context and event in ("PreToolUse", "PostToolUse"):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}},
                         ensure_ascii=False))
    elif event == "beforeMCPExecution":
        print(json.dumps({"permission": "allow"}))
    else:
        print(json.dumps({"continue": True}))


def out_deny(event, reason):
    if event == "beforeMCPExecution":
        print(json.dumps({"permission": "deny", "user_message": reason, "agent_message": reason},
                         ensure_ascii=False))
    else:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}},
                         ensure_ascii=False))


def target_from_bash(command):
    if "session/prompt" not in command and '"prompt"' not in command:
        return None, None
    match = RPC_URL.search(command)
    return (match.group(2), match.group(1)) if match else (None, None)


def handle(payload):
    event = payload.get("hook_event_name") or ""
    tool = payload.get("tool_name") or ""
    args = parse_input(payload.get("tool_input"))
    session_id = payload.get("session_id") or payload.get("conversation_id") or ""
    is_dc = "drive-coding" in tool or payload.get("mcp_server_name") == "drive-coding"

    if event == "PostToolUse" and is_dc and tool.endswith("session_open"):
        text = json.dumps(payload.get("tool_response"), ensure_ascii=False)
        match = re.search(r'\\?"agent\\?"\s*:\s*\\?"(' + UUID + ')', text)
        if not match:
            return out_allow(event)
        agent_id = match.group(1)
        state, cli = lookup(agent_id)
        mode = ((state or {}).get("modes") or {}).get("currentModeId")
        if not state:
            return out_allow(event)
        note = f"הסוכן {agent_id} נפתח במצב ההרשאות '{mode}'."
        warn = mode_warning(agent_id, state, cli)
        if warn:
            warn_once(session_id, agent_id)
            note = note + " " + warn
        log({"event": event, "agent": agent_id, "cli": cli, "mode": mode})
        return out_allow(event, note)

    agent_id = base = None
    changes_mode = False
    if is_dc and tool.endswith("session_send"):
        agent_id = args.get("agent")
        sets = args.get("sets") or {}
        changes_mode = isinstance(sets, dict) and any("mode" in str(k).lower() for k in sets)
    elif tool in ("Bash", "Shell"):
        agent_id, base = target_from_bash(args.get("command") or "")
    if not agent_id:
        return out_allow(event)

    state, cli = lookup(agent_id, base)
    if not state:
        return out_allow(event)
    reason = pending_reason(agent_id, state)
    if reason:
        log({"event": event, "agent": agent_id, "decision": "deny", "reason": "pending-permission"})
        return out_deny(event, reason)
    warn = None if changes_mode else mode_warning(agent_id, state, cli)
    if warn and event == "PreToolUse" and warn_once(session_id, agent_id):
        log({"event": event, "agent": agent_id, "decision": "warn", "cli": cli})
        return out_allow(event, warn)
    return out_allow(event)


def main():
    try:
        handle(json.load(sys.stdin))
    except Exception as exc:  # fail-open
        log({"error": repr(exc)})
        print(json.dumps({"continue": True}))
    sys.exit(0)


if __name__ == "__main__":
    main()
