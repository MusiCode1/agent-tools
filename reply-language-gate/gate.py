#!/usr/bin/env python3
"""Claude Code Stop hook and shared exception storage."""

import fcntl
import json
import os
from pathlib import Path
import re
import shlex
from string import Formatter
import sys
from tempfile import NamedTemporaryFile
import time
import unicodedata


SCRIPTS = {
    "hebrew": ("עברית", re.compile(r"[\u0590-\u05ff\ufb1d-\ufb4f]")),
    "arabic": ("العربية", re.compile(r"[\u0600-\u06ff\u0750-\u077f\u0870-\u08ff\ufb50-\ufdff\ufe70-\ufeff]")),
    "cyrillic": ("Cyrillic", re.compile(r"[\u0400-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f]")),
    "greek": ("Ελληνικά", re.compile(r"[\u0370-\u03ff\u1f00-\u1fff]")),
}
DEFAULT_MESSAGE = (
    "כתוב מחדש את התשובה האחרונה במלואה ב-{language} (השיעור שנמדד: {ratio}). "
    "השאר מונחים טכניים, פקודות, נתיבים וקוד בשפת המקור. אל תוסיף הסבר על השכתוב. "
    "אם המשתמש ביקש במפורש בסשן הזה שפה אחרת, הרץ את הפקודה "
    '{allow_cmd} והחלף את "<ציטוט>" בציטוט הבקשה, ואז המשך בשפה שביקש.'
)
ALLOW_TTL = 30 * 24 * 60 * 60


def xdg_path(kind, default, *parts):
    root = os.environ.get(f"XDG_{kind}_HOME") or default
    return Path(root).expanduser().joinpath(*parts)


def allow_path():
    return xdg_path("STATE", "~/.local/state", "reply-language-gate", "allow.jsonl")


def read_allowed(path, now):
    try:
        with path.open(encoding="utf-8") as source:
            return {
                record["session_id"]: record
                for record in map(json.loads, source)
                if record["ts"] >= now - ALLOW_TTL
            }
    except FileNotFoundError:
        return {}


def update_allowed(session_id, reason):
    path = allow_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Lock a separate file because the data file is replaced atomically.
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = time.time()
        records = read_allowed(path, now)
        if reason is None:
            records.pop(session_id, None)
        else:
            records[session_id] = {"session_id": session_id, "ts": now, "reason": reason}
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as target:
            temporary = Path(target.name)
            try:
                for record in records.values():
                    target.write(json.dumps(record, ensure_ascii=False) + "\n")
                target.flush()
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)


def log_event(event, session_id, ratio):
    path = xdg_path("CACHE", "~/.cache", "reply-language-gate.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"event": event, "ts": time.time(), "session_id": session_id, "ratio": ratio}
    with path.open("a", encoding="utf-8") as log:
        log.write(json.dumps(record, ensure_ascii=True) + "\n")


def load_config():
    path = xdg_path("CONFIG", "~/.config", "reply-language-gate", "config.json")
    try:
        with path.open(encoding="utf-8") as source:
            config = json.load(source)
    except FileNotFoundError:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("config must be a JSON object")

    language = os.environ.get("REPLY_LANG", config.get("language", "hebrew"))
    min_ratio = float(os.environ.get("REPLY_LANG_MIN_RATIO", config.get("min_ratio", 0.6)))
    min_letters = int(os.environ.get("REPLY_LANG_MIN_LETTERS", config.get("min_letters", 40)))
    message = os.environ.get("REPLY_LANG_MESSAGE", config.get("message", DEFAULT_MESSAGE))
    if not 0 <= min_ratio <= 1 or min_letters < 0:
        raise ValueError("invalid language threshold")
    return SCRIPTS[language], min_ratio, min_letters, message


def last_assistant_text(data):
    message = data.get("last_assistant_message")
    if isinstance(message, str) and message.strip():
        return message
    path = data.get("transcript_path")
    if not path:
        return ""
    last = ""
    try:
        with Path(path).expanduser().open(encoding="utf-8", errors="replace") as source:
            for line in source:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant":
                    continue
                content = (entry.get("message") or {}).get("content")
                if isinstance(content, list):
                    content = "\n".join(
                        part["text"] for part in content
                        if isinstance(part, dict) and part.get("type") == "text"
                        and isinstance(part.get("text"), str)
                    )
                if isinstance(content, str) and content.strip():
                    last = content
    except FileNotFoundError:
        return ""
    return last


def strip_technical(message):
    message = re.sub(r"```.*?(?:```|\Z)|~~~.*?(?:~~~|\Z)", " ", message, flags=re.S)
    message = re.sub(r"`+[^`\n]*`+", " ", message)
    message = re.sub(r"\]\([^)]*\)", "]", message)
    message = re.sub(r"https?://\S+", " ", message)
    return re.sub(r"(?<!\w)(?:~?/|\.{1,2}/)[\w./\-@:]+", " ", message)


def render_message(template, fields):
    if not isinstance(template, str):
        raise ValueError("message must be a string")
    for _, field, spec, conversion in Formatter().parse(template):
        if field is not None and (field not in fields or spec or conversion):
            raise ValueError("invalid message placeholder")
    message = template.format_map(fields)
    if not message.strip():
        raise ValueError("message must not be empty")
    return message


def main():
    session_id = ratio = None
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            raise ValueError("hook input must be a JSON object")
        if data.get("hook_event_name", "Stop") != "Stop":
            return
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            session_id = None
            raise ValueError("missing session_id")
        if session_id in read_allowed(allow_path(), time.time()):
            log_event("skip-allowed", session_id, ratio)
            return

        (language, script), min_ratio, min_letters, template = load_config()
        letters = [letter for letter in strip_technical(last_assistant_text(data)) if letter.isalpha()]
        target = sum(bool(script.fullmatch(letter)) for letter in letters)
        latin = sum(unicodedata.name(letter, "").startswith("LATIN ") for letter in letters)
        total = target + latin
        if not total or total < min_letters:
            return
        ratio = target / total
        if ratio >= min_ratio:
            return
        if data.get("stop_hook_active"):
            log_event("loop-warn", session_id, ratio)
            print(json.dumps({"systemMessage": f"בדיקת שפת תשובה ({language}) נכשלה גם בשכתוב ({ratio:.0%})."}))
            return

        session_arg = shlex.quote(f"--session={session_id}")
        fields = {
            "language": language,
            "ratio": f"{ratio:.0%}",
            "session_id": session_id,
            "allow_cmd": f'reply-language-gate allow {session_arg} --reason "<ציטוט>"',
        }
        try:
            reason = render_message(template, fields)
        except ValueError:
            log_event("error", session_id, ratio)
            reason = DEFAULT_MESSAGE.format_map(fields)
        log_event("block", session_id, ratio)
        print(json.dumps({"decision": "block", "reason": reason}))
    except Exception:
        # Diagnostics must never make a failed hook block the turn.
        try:
            log_event("error", session_id, ratio)
        except Exception:
            pass


if __name__ == "__main__":
    main()
