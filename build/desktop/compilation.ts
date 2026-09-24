import { type ChildProcess, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { desktopBuildPath } from '../lib/paths.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = join(repositoryRoot, 'ash-ts');
const outputRoot = desktopBuildPath(repositoryRoot);
const typescript = join(sourceRoot, 'node_modules/typescript/bin/tsc');
const preloadPath = join(outputRoot, 'preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs');

export type CompilationTarget = 'main' | 'preload' | 'renderer';

export function compilationTargets(args: readonly string[]): readonly CompilationTarget[] {
  if (args.length === 0) return ['main', 'preload'];
  for (const arg of args) {
    if (!['main', 'preload', 'renderer'].includes(arg)) throw new Error(`Unknown compilation target: ${arg}`);
  }
  return [...new Set(args)] as CompilationTarget[];
}

export async function prepareCompilation(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n');
  const link = join(outputRoot, 'node_modules');
  const expected = await realpath(join(sourceRoot, 'node_modules'));
  try {
    const metadata = await lstat(link);
    if (!metadata.isSymbolicLink()) throw new Error(`Build dependency path is not a directory link: ${link}`);
    try {
      if (await realpath(link) === expected) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await unlink(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await symlink(expected, link, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function compile(targets: readonly CompilationTarget[]): Promise<void> {
  await prepareCompilation();
  for (const target of targets) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(process.execPath, compilerArguments(target), { cwd: sourceRoot, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`${target} compilation ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
      });
    });
    if (target === 'preload') await verifyPreload();
  }
}

/** Reports readiness only after every watched project and its emitted artifacts pass validation. */
export async function watchCompilation(targets: readonly CompilationTarget[], onChange: (ready: boolean) => void): Promise<{ close: () => Promise<void>; done: Promise<void> }> {
  await prepareCompilation();
  const ready = new Map(targets.map(target => [target, false]));
  const children: ChildProcess[] = [];
  let revision = 0;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const completion = Promise.withResolvers<void>();

  for (const target of targets) {
    const child = spawn(process.execPath, [...compilerArguments(target), '--watch', '--preserveWatchOutput', '--pretty', 'false'], {
      cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.push(child);
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    stdout.on('line', line => {
      console.log(`[${target}] ${line}`);
      if (/Starting compilation in watch mode|File change detected\. Starting incremental compilation/u.test(line)) {
        revision++;
        clearTimeout(timer);
        ready.set(target, false);
        onChange(false);
      }
      const completed = line.match(/Found (\d+) errors?\. Watching for file changes\./u);
      if (!completed) return;
      ready.set(target, Number(completed[1]) === 0);
      clearTimeout(timer);
      const current = revision;
      timer = setTimeout(() => { void validate(current); }, 150);
    });
    stderr.on('line', line => console.error(`[${target}] ${line}`));
    child.once('error', fail);
    child.once('close', (code, signal) => {
      stdout.close();
      stderr.close();
      if (!closing) fail(new Error(`${target} watcher ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
    });
  }

  async function validate(current: number): Promise<void> {
    if (closing || current !== revision || [...ready.values()].some(value => !value)) return;
    try {
      if (ready.has('preload')) await verifyPreload();
      if (!closing && current === revision) onChange(true);
    } catch (error) {
      console.error(`[compilation] ${error instanceof Error ? error.message : error}`);
      if (!closing && current === revision) onChange(false);
    }
  }

  function fail(error: Error): void {
    completion.reject(error);
    void close();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    clearTimeout(timer);
    closing = Promise.all(children.map(child => new Promise<void>(resolvePromise => {
      if (child.exitCode !== null || child.signalCode !== null) { resolvePromise(); return; }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('close', () => { clearTimeout(timeout); resolvePromise(); });
      child.kill('SIGTERM');
    }))).then(() => { completion.resolve(); });
    return closing;
  }
  return { close, done: completion.promise };
}

function compilerArguments(target: CompilationTarget): string[] {
  const args = [typescript, '-p', `tsconfig.${target}.json`];
  if (target === 'renderer') args.push('--noEmit');
  return args;
}

async function verifyPreload(): Promise<void> {
  const source = await readFile(preloadPath, 'utf8');
  const requiredModules = [...source.matchAll(/\brequire\(\s*(["'])(?<module>[^"']+)\1\s*\)/g)].map(match => match.groups?.module);
  if ([...source.matchAll(/\brequire\s*\(/g)].length !== requiredModules.length) {
    throw new Error('Sandbox preload contains a non-literal runtime import');
  }
  const unsupported = requiredModules.filter(module => module !== 'electron');
  if (unsupported.length) throw new Error(`Sandbox preload contains unsupported runtime imports: ${[...new Set(unsupported)].join(', ')}`);
  if (!requiredModules.includes('electron')) throw new Error('Sandbox preload does not import Electron');
  if (/\bimport\s*\(/.test(source)) throw new Error('Sandbox preload contains a dynamic runtime import');
}
