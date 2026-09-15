import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "../../../ash-ts");
const typescriptExecutable = resolve(desktopRoot, "node_modules/typescript/bin/tsc");
const electronRunner = resolve(import.meta.dirname, "../../desktop/runElectron.ts");
const settleDelayMs = 150;
const stopTimeoutMs = 5_000;

const projects = Object.freeze([
  Object.freeze({ name: "main", config: "tsconfig.main.json" }),
  Object.freeze({ name: "preload", config: "tsconfig.preload.json" }),
]);

type TypeScriptWatchStatus = Readonly<{ type: "building" }> | Readonly<{ type: "complete"; errors: number }>;

/** Converts one stable TypeScript watch status line into compile-gate state. */
export function parseTypeScriptWatchStatus(line: string): TypeScriptWatchStatus | undefined {
  if (/Starting compilation in watch mode|File change detected\. Starting incremental compilation/u.test(line)) {
    return Object.freeze({ type: "building" });
  }
  const completion = line.match(/Found (\d+) errors?\. Watching for file changes\./u);
  if (!completion) return undefined;
  return Object.freeze({ type: "complete", errors: Number(completion[1]) });
}

/** Coordinates independently watched projects into one safe Electron restart boundary. */
export class ElectronCompileGate {
  private readonly states: Map<string, boolean>;
  private dirty = false;

  constructor(projectNames: readonly string[]) {
    if (projectNames.length === 0 || new Set(projectNames).size !== projectNames.length) {
      throw new TypeError("Electron compile gate requires unique project names");
    }
    this.states = new Map(projectNames.map(name => [name, false]));
  }

  public begin(project: string): void {
    this.requireProject(project);
    this.states.set(project, false);
    this.dirty = true;
  }

  public complete(project: string, errors: number): void {
    this.requireProject(project);
    if (!Number.isSafeInteger(errors) || errors < 0) throw new TypeError("TypeScript error count must be a non-negative integer");
    this.states.set(project, errors === 0);
  }

  public consumeRestart(): boolean {
    if (!this.dirty || [...this.states.values()].some(ready => !ready)) return false;
    this.dirty = false;
    return true;
  }

  private requireProject(project: string): void {
    if (!this.states.has(project)) throw new RangeError(`Unknown Electron TypeScript project: ${project}`);
  }
}

function start(): void {
  const gate = new ElectronCompileGate(projects.map(project => project.name));
  const watchers: ChildProcess[] = [];
  let electron: ChildProcess | undefined;
  let restartRequested = false;
  let restarting = false;
  let settleTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  for (const project of projects) {
    const watcher = spawn(process.execPath, [
      typescriptExecutable,
      "-p",
      project.config,
      "--watch",
      "--preserveWatchOutput",
      "--pretty",
      "false",
    ], {
      cwd: desktopRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    watchers.push(watcher);
    forwardLines(watcher.stdout, project.name, line => {
      const status = parseTypeScriptWatchStatus(line);
      if (status?.type === "building") {
        clearTimeout(settleTimer);
        gate.begin(project.name);
      } else if (status?.type === "complete") {
        gate.complete(project.name, status.errors);
        scheduleRestart();
      }
    });
    forwardLines(watcher.stderr, project.name);
    watcher.once("error", error => stopWithError(`${project.name} watcher failed: ${error.message}`));
    watcher.once("exit", (code, signal) => {
      if (!stopped) stopWithError(`${project.name} watcher ${signal ? `stopped by ${signal}` : `exited with status ${code ?? "unknown"}`}`);
    });
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  function scheduleRestart(): void {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!gate.consumeRestart() || stopped) return;
      restartRequested = true;
      void drainRestarts();
    }, settleDelayMs);
  }

  async function drainRestarts(): Promise<void> {
    if (restarting) return;
    restarting = true;
    try {
      while (restartRequested && !stopped) {
        restartRequested = false;
        if (electron) await stopChild(electron);
        if (stopped) break;
        electron = spawn(process.execPath, [electronRunner, ...process.argv.slice(2)], {
          cwd: desktopRoot,
          env: process.env,
          stdio: "inherit",
          windowsHide: true,
        });
        electron.once("error", error => stopWithError(`Electron runner failed: ${error.message}`));
        electron.once("exit", () => {
          electron = undefined;
        });
      }
    } finally {
      restarting = false;
    }
  }

  function stopWithError(message: string): void {
    console.error(`[electron-host] ${message}`);
    process.exitCode = 1;
    stop();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(settleTimer);
    for (const watcher of watchers) watcher.kill("SIGTERM");
    if (electron) void stopChild(electron);
  }
}

function forwardLines(stream: Readable, project: string, onLine: (line: string) => void = () => {}): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line) console.log(`[${project}] ${line}`);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (!buffered) return;
    console.log(`[${project}] ${buffered}`);
    onLine(buffered);
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>(resolvePromise => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes("--validate-startup")) new ElectronCompileGate(projects.map(project => project.name));
  else start();
}
