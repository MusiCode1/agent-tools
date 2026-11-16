# drive-coding-hooks

Hooks for agents that open and drive other agents through drive-coding.

## `agent_state_gate.py` — check a child's permission state before prompting it

A child opened with a permission policy can still come up in a manual mode. It then
stops on its first tool call and waits for a human, while the parent sees what looks
like an ended turn, sends the next prompt into the open turn, and reads an empty
answer as final. The hook closes that gap:

| Event | What it does |
|---|---|
| `PreToolUse` on `mcp__drive-coding__session_send` | **Deny** when `pending.permission` is set; **warn once** per agent when a Claude child is not in `bypassPermissions`, or reports no mode at all, and the call does not change the mode |
| `PreToolUse` on `Bash` | Same check for `curl …/api/agents/<id>/rpc` with `session/prompt`, against the base URL in the command |
| `PostToolUse` on `mcp__drive-coding__session_open` | Inject the mode the child opened in |
| Cursor `beforeMCPExecution` | Deny on a pending permission |

Fail-open: an unknown agent, an unreachable backend or a malformed payload allows the
call. Backends: `DRIVE_CODING_GATE_BASES` (comma-separated), default
`http://127.0.0.1:4000,4001,4002`. Calls made on another machine through `ssh` are not
visible to a local hook. Log: `~/.cache/drive-coding-agent-state-gate.jsonl`.

### Wiring

Claude Code, `~/.claude/settings.json` (entries next to existing ones):

```json
{"hooks": {
  "PreToolUse": [
    {"matcher": "mcp__drive-coding__session_send", "hooks": [{"type": "command", "command": "python3 /path/to/agent-tools/drive-coding-hooks/agent_state_gate.py"}]},
    {"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 /path/to/agent-tools/drive-coding-hooks/agent_state_gate.py"}]}
  ],
  "PostToolUse": [
    {"matcher": "mcp__drive-coding__session_open", "hooks": [{"type": "command", "command": "python3 /path/to/agent-tools/drive-coding-hooks/agent_state_gate.py"}]}
  ]
}}
```

Cursor, `~/.cursor/hooks.json`: add the same command under `beforeMCPExecution`.
Cursor refuses a hooks file whose path contains a symlink, so edit the file itself.
Codex: a new hook needs trust approval in the Codex TUI before it runs.

### Test

```bash
python3 -I drive-coding-hooks/test_agent_state_gate.py
```
