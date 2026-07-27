import json
import os
from pathlib import Path

def _on_post_tool_call(**kwargs):
    event = {
        key: kwargs.get(key)
        for key in ("tool_name", "task_id", "session_id", "tool_call_id", "duration_ms", "status")
    }
    event["args"] = kwargs.get("args", {})
    event["result"] = str(kwargs.get("result", ""))[:500]
    with Path(os.environ["HERMES_EVAL_TRACE"]).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, sort_keys=True) + "\n")

def register(ctx):
    ctx.register_hook("post_tool_call", _on_post_tool_call)
