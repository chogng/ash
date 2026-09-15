import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { ElectronCompileGate, parseTypeScriptWatchStatus } from "./electron.ts";

test("Electron watcher launches both compilers and restarts the runner after a successful rebuild", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ash-watch-"));
  const desktop = join(root, "ash-ts");
  await mkdir(join(root, "build/desktop/watch"), { recursive: true });
  await mkdir(join(desktop, "node_modules/typescript/bin"), { recursive: true });
  await copyFile(join(import.meta.dirname, "electron.ts"), join(root, "build/desktop/watch/electron.ts"));
  await writeFile(join(desktop, "node_modules/typescript/bin/tsc"), `
    const fs = require('node:fs');
    const project = process.argv[process.argv.indexOf('-p') + 1];
    fs.appendFileSync('compilers.log', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
    console.log('Starting compilation in watch mode');
    console.log('Found 0 errors. Watching for file changes.');
    let rebuilt = false;
    setInterval(() => {
      if (fs.existsSync('stop')) process.exit(0);
      if (!rebuilt && project === 'tsconfig.main.json' && fs.existsSync('rebuild')) {
        rebuilt = true;
        console.log('File change detected. Starting incremental compilation');
        console.log('Found 0 errors. Watching for file changes.');
      }
    }, 25);
  `);
  await writeFile(join(root, "build/desktop/runElectron.ts"), `
    import { appendFileSync } from 'node:fs';
    appendFileSync('launches.log', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [join(root, "build/desktop/watch/electron.ts"), "--fixture"], { cwd: tmpdir(), windowsHide: true, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    await writeFile(join(desktop, "stop"), "");
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  async function waitForLaunches(count: number): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const text = await readFile(join(desktop, "launches.log"), "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      const lines = text.trim().split("\n").filter(Boolean);
      if (lines.length >= count) return lines;
      assert.equal(child.exitCode, null, output);
      await delay(50);
    }
    assert.fail(`Runner did not launch ${count} times: ${output}`);
  }
  await waitForLaunches(1);
  const compilers = (await readFile(join(desktop, "compilers.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(compilers.map(entry => entry.args[1]).sort(), ["tsconfig.main.json", "tsconfig.preload.json"]);
  for (const compiler of compilers) {
    assert.equal(compiler.cwd, desktop);
    assert.ok(compiler.args.includes("--watch"));
  }
  await writeFile(join(desktop, "rebuild"), "");
  const launches = await waitForLaunches(2);
  assert.equal(launches.length, 2);
  for (const line of launches) assert.deepEqual(JSON.parse(line), { cwd: desktop, args: ["--fixture"] });
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
