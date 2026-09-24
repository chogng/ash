import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { watchCompilation } from '../build/desktop/compilation.ts';

const sourceRoot = resolve(import.meta.dirname, '../ash-ts');
const require = createRequire(resolve(sourceRoot, 'package.json'));
const executable: string = require('electron');
const args = process.argv.slice(2);
const watch = args[0] === '--watch';
if (watch) args.shift();
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

let electron: ChildProcess | undefined;
let watcher: Awaited<ReturnType<typeof watchCompilation>> | undefined;
let ready = false;
let restarting = false;
let stopped = false;

function launch(): void {
  const child = spawn(executable, [sourceRoot, ...args], { cwd: sourceRoot, env: environment, stdio: 'inherit', windowsHide: true });
  electron = child;
  child.once('error', error => { console.error(error); process.exitCode = 1; void stop(); });
  child.once('exit', code => {
    if (electron === child) electron = undefined;
    if (!watch) process.exitCode = code ?? 1;
  });
}

async function restart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  try {
    while (ready && !stopped) {
      if (electron) await stopElectron(electron);
      if (!ready || stopped) break;
      ready = false;
      launch();
    }
  } finally {
    restarting = false;
  }
}

function stopElectron(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolvePromise => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('close', () => { clearTimeout(timeout); resolvePromise(); });
    child.kill('SIGTERM');
  });
}

async function stop(): Promise<void> {
  if (stopped) return;
  stopped = true;
  await Promise.all([watcher?.close(), electron ? stopElectron(electron) : undefined]);
}

process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
if (watch) {
  watcher = await watchCompilation(['main', 'preload'], current => {
    ready = current;
    if (ready) void restart();
  });
  if (stopped) await watcher.close();
  try {
    await watcher.done;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    await stop();
  }
} else {
  launch();
}
