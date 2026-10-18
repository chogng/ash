#!/usr/bin/env python3
"""Deterministic AudioHost v2 device boundary; no microphone or speaker is opened."""
import json
import math
import struct
import sys
import threading
import time

lock = threading.Lock()
state = {"epoch": 0, "rate": 48000, "recording": False, "sequence": 0}


def emit(event):
    payload = json.dumps(event, separators=(",", ":")).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def capture():
    while True:
        time.sleep(0.02)
        with lock:
            if state["recording"]:
                state["sequence"] += 1
                count = state["rate"] // 50
                samples = [int(6000 * math.sin(i * math.tau * 440 / state["rate"])) for i in range(count)]
                emit({"event": "capture", "audio": {"epoch": state["epoch"], "sequence": state["sequence"], "samples": samples}})


threading.Thread(target=capture, daemon=True).start()
while header := sys.stdin.buffer.read(4):
    if len(header) != 4:
        raise SystemExit(2)
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= 16384:
        raise SystemExit(2)
    request = json.loads(sys.stdin.buffer.read(length))
    command = request["command"]
    operation = command["operation"]
    with lock:
        if operation in ("start", "capture", "interrupt", "stop", "shutdown"):
            state["epoch"] += 1
        if operation == "start":
            state["rate"] = int(command["config"]["rate"])
            state["recording"] = command["config"]["direction"] != "playback"
        elif operation == "capture":
            state["recording"] = command["state"] == "recording"
        elif operation in ("stop", "shutdown"):
            state["recording"] = False
        emit({"event": "reply", "id": request["id"], "epoch": state["epoch"], "error": None})
    if operation == "shutdown":
        break
