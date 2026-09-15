import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { ElectronCompileGate, parseTypeScriptWatchStatus } from "./electron.ts";

test("Electron TypeScript watcher initializes through its real CLI entry", () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "electron.ts"), "--validate-startup"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Electron TypeScript watcher recognizes complete watch cycles", () => {
  assert.deepEqual(parseTypeScriptWatchStatus("7:13:14 PM - Starting compilation in watch mode..."), { type: "building" });
  assert.deepEqual(parseTypeScriptWatchStatus("7:13:15 PM - File change detected. Starting incremental compilation..."), { type: "building" });
  assert.deepEqual(parseTypeScriptWatchStatus("7:13:16 PM - Found 0 errors. Watching for file changes."), { type: "complete", errors: 0 });
  assert.deepEqual(parseTypeScriptWatchStatus("Found 2 errors. Watching for file changes."), { type: "complete", errors: 2 });
  assert.equal(parseTypeScriptWatchStatus("src/main.ts(1,1): error TS1005"), undefined);
});

test("Electron compile gate restarts only after every project is current", () => {
  const gate = new ElectronCompileGate(["main", "preload"]);
  gate.begin("main");
  gate.begin("preload");
  gate.complete("main", 0);
  assert.equal(gate.consumeRestart(), false);
  gate.complete("preload", 0);
  assert.equal(gate.consumeRestart(), true);
  assert.equal(gate.consumeRestart(), false);

  gate.begin("main");
  gate.complete("main", 1);
  assert.equal(gate.consumeRestart(), false);
  gate.begin("main");
  gate.complete("main", 0);
  assert.equal(gate.consumeRestart(), true);
});

test("Electron compile gate rejects ambiguous project state", () => {
  assert.throws(() => new ElectronCompileGate([]), /unique project names/u);
  assert.throws(() => new ElectronCompileGate(["main", "main"]), /unique project names/u);
  const gate = new ElectronCompileGate(["main"]);
  assert.throws(() => gate.begin("preload"), /Unknown Electron TypeScript project/u);
  assert.throws(() => gate.complete("main", -1), /non-negative integer/u);
});
