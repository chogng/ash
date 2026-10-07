"""Extract only explicitly named time-benchmark children from their parent's rollout."""

import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

NAME = re.compile(r"/root/time_(context_a|tool_b)(\d+)$")


def millis(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    children = {}
    for line in args.parent_log.open():
        event = json.loads(line)
        payload = event.get("payload", {})
        item = payload.get("item", {})
        if item.get("type") != "SubAgentActivity":
            continue
        match = NAME.fullmatch(item.get("agent_path", ""))
        if match:
            children[item["agent_thread_id"]] = (
                item["agent_path"],
                match.group(1),
                int(match.group(2)),
            )
    rows = []
    for child_id, (name, variant, pair) in sorted(
        children.items(), key=lambda row: (row[1][2], row[1][1])
    ):
        paths = list(args.parent_log.parent.parent.glob("*/*" + child_id + "*.jsonl"))
        if len(paths) != 1:
            raise RuntimeError("Expected one exact child rollout: " + name)
        path = paths[0]
        rows.append(extract(path, name, variant, pair))
    args.output.write_text(
        json.dumps(
            {
                "model": "gpt-5.6-sol",
                "scope": "Codex child task traces, not direct standalone API TTFT",
                "pilot_pairs": [1, 2],
                "script_sha256": hashlib.sha256(
                    Path(__file__).read_bytes()
                ).hexdigest(),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    for row in rows:
        print(
            row["name"],
            row.get("model_pipeline_ms"),
            row.get("task_ms"),
            row.get("tool_calls"),
            row.get("usage"),
        )


def extract(path, name, variant, pair):
    result = {
        "name": name,
        "pair": pair,
        "variant": variant,
        "pilot": pair <= 2,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    calls, outputs, usage = [], [], []
    for line in path.open():
        event = json.loads(line)
        p = event.get("payload", {})
        kind = p.get("type")
        timestamp = event["timestamp"]
        if event["type"] == "turn_context":
            result.update(
                model=p.get("model"), effort=p.get("effort"), context_at=timestamp
            )
        elif event["type"] == "event_msg":
            if kind == "task_started":
                result["started_at"] = timestamp
            if kind == "task_complete":
                result["completed_at"] = timestamp
            if kind == "token_count" and p.get("info"):
                total = p["info"]["total_token_usage"]
                if not usage or total != usage[-1]:
                    usage.append(total)
        elif event["type"] == "response_item":
            if kind in ("function_call", "custom_tool_call"):
                calls.append(
                    {"name": p["name"], "at": timestamp, "call_id": p["call_id"]}
                )
            elif kind in ("function_call_output", "custom_tool_call_output"):
                outputs.append({"at": timestamp, "call_id": p["call_id"]})
            elif (
                kind == "message"
                and p.get("role") == "assistant"
                and p.get("phase") == "final_answer"
            ):
                result["final_at"] = timestamp
    result.update(
        tool_calls=len(calls),
        calls=calls,
        outputs=outputs,
        usage=usage[-1] if usage else None,
        usage_updates=len(usage),
    )
    if "completed_at" not in result:
        return result
    result["task_ms"] = round(
        millis(result["completed_at"]) - millis(result["started_at"]), 3
    )
    result["model_pipeline_ms"] = round(
        millis(result["final_at"]) - millis(result["context_at"]), 3
    )
    if len(calls) == len(outputs) == 1:
        result["tool_wall_ms"] = round(
            millis(outputs[0]["at"]) - millis(calls[0]["at"]), 3
        )
        result["after_tool_ms"] = round(
            millis(result["final_at"]) - millis(outputs[0]["at"]), 3
        )
    result["valid_shape"] = (
        result["model"] == "gpt-5.6-sol"
        and result["tool_calls"] == (0 if variant == "context_a" else 1)
        and len(usage) == (1 if variant == "context_a" else 2)
    )
    return result


if __name__ == "__main__":
    main()
