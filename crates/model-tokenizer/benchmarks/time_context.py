# /// script
# requires-python = ">=3.12"
# dependencies = ["tiktoken==0.12.0"]
# ///
"""Count time-fragment text tokens, not provider message framing or billed usage."""

import argparse
import hashlib
import importlib.metadata
import json
import platform
from datetime import UTC, datetime
from pathlib import Path

import tiktoken

SAMPLES = {
    "date": "2026-09-12",
    "timestamp_with_offset": "2026-09-12T19:29:47-07:00",
    "chinese_sentence": "当前时间：2026-09-12 19:29:47",
    "tagged_timestamp": "<current_time>2026-09-12T19:29:47-07:00</current_time>",
    "timestamp_and_zone": "<time_context>\nnow: 2026-09-12T19:29:47-07:00\ntimezone: America/Los_Angeles\n</time_context>",
    "request_reference_and_now": "<time_context>\nrequest_received_at: 2026-09-12T23:59:50-07:00\nsampled_at: 2026-09-13T00:00:05-07:00\ntimezone: America/Los_Angeles\n</time_context>",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = []
    for name in ("cl100k_base", "o200k_base"):
        encoding = tiktoken.get_encoding(name)
        for label, text in SAMPLES.items():
            ids = encoding.encode(text)
            assert encoding.decode(ids) == text
            rows.append(
                {
                    "encoding": name,
                    "sample": label,
                    "text": text,
                    "utf8_bytes": len(text.encode()),
                    "text_tokens": len(ids),
                    "token_ids": ids,
                }
            )
    result = {
        "measured_at_utc": datetime.now(UTC).isoformat(),
        "python": platform.python_version(),
        "tiktoken": importlib.metadata.version("tiktoken"),
        "scope": "text fragments only; no provider framing, inference, billing, or model-to-encoding assertion",
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "samples": rows,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    for row in rows:
        print(row["encoding"], row["sample"], row["text_tokens"])


if __name__ == "__main__":
    main()
