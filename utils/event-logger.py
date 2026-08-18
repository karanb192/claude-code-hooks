#!/usr/bin/env python3
"""
Event Logger - Logs all Claude Code hook events to a file for inspection.

When building custom hooks, it helps to see exactly what data Claude Code
provides for each event. This utility logs all hook events so you can inspect
payload structures and discover available fields before writing your own hooks.

Output: ~/.claude/hooks-logs/YYYY-MM-DD.jsonl

Setup in .claude/settings.json (add to any/all events you want to inspect):
{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "command", "command": "python /path/to/event-logger.py"}]}],
    "PostToolUse": [{"hooks": [{"type": "command", "command": "python /path/to/event-logger.py"}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "python /path/to/event-logger.py"}]}]
  }
}

All 13 supported events:
  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
  PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop,
  Stop, PreCompact, Setup, Notification

View logs:
  cat ~/.claude/hooks-logs/$(date +%Y-%m-%d).jsonl | jq
  tail -f ~/.claude/hooks-logs/$(date +%Y-%m-%d).jsonl | jq
  cat ~/.claude/hooks-logs/*.jsonl | jq 'select(.hook_event_name=="PreToolUse")'
"""

import sys
import json
import os
from datetime import datetime
from pathlib import Path


def get_log_file_path():
    log_dir = Path.home() / ".claude" / "hooks-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / f"{datetime.now().strftime('%Y-%m-%d')}.jsonl"


def truncate(value, max_len=2000):
    if isinstance(value, str) and len(value) > max_len:
        return f"{value[:max_len]}... ({len(value)} chars)"
    return value


def process(value, max_str=2000, max_list=50):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return truncate(value, max_str)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        items = [process(v) for v in value[:max_list]]
        if len(value) > max_list:
            items.append(f"... +{len(value) - max_list} more")
        return items
    if isinstance(value, dict):
        return {str(k): process(v) for k, v in value.items()}
    return str(value)


def main():
    stdin_data = sys.stdin.read()

    try:
        data = json.loads(stdin_data) if stdin_data else {}
    except json.JSONDecodeError:
        data = {"_raw": stdin_data}

    event = {
        "ts": datetime.now().isoformat(),
        "hook_event_name": data.get("hook_event_name", "unknown"),
        "cwd": os.getcwd(),
        "data": process(data),
    }

    log_file = get_log_file_path()
    with open(log_file, "a") as f:
        f.write(json.dumps(event, default=str) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[event-logger] Error: {e}", file=sys.stderr)
