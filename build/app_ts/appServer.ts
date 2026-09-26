import { type ChildProcess, spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { generateProtocol } from '../protocol/generate.ts';
import { pythonCommand } from '../python.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sharedRustSource = resolve(repositoryRoot, 'ash-rs');
const configuredTargetDirectory = process.env.CARGO_TARGET_DIR?.trim();
const targetDirectory = resolve(repositoryRoot, configuredTargetDirectory || '.build/cargo');
const watchedTargetDirectory = relativeWatchedDirectory(sharedRustSource, targetDirectory);
const debounceMs = 250;

export function shouldRebuildAppServer(file: string | null, ignoredDirectory?: string): boolean {
  if (typeof file !== 'string') return false;
  const normalized = file.replaceAll('\\', '/');
  if (/(?:^|\/)target(?:\/|$)/u.test(normalized)) return false;
  const ignored = ignoredDirectory?.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (ignored !== undefined && (ignored === '' || normalized === ignored || normalized.startsWith(`${ignored}/`))) return false;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return file.endsWith('.rs') || (normalized.startsWith('app-server-protocol/src/') && file.endsWith('.template.ts')) || name === 'Cargo.toml' || name === 'Cargo.lock' || name === 'build.rs';
}

export function relativeWatchedDirectory(watchRoot: string, directory: string): string | undefined {
  const candidate = relative(resolve(watchRoot), resolve(directory));
  if (isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`)) return undefined;
  return candidate.replaceAll('\\', '/');
}

export function shouldRebuildWorkspaceManifest(file: string | null): boolean {
  return file === 'Cargo.toml' || file === 'Cargo.lock';
}

export async function watchAppServer(options: { skipInitial?: boolean } = {}): Promise<() => void> {
  let activeBuild: ChildProcess | undefined;
  let buildRequested = !options.skipInitial;
  let debounce: NodeJS.Timeout | undefined;
  let stopped = false;
  let building = false;
  const cancellation = new AbortController();
  const watchers: FSWatcher[] = [];

  watchers.push(
    watch(sharedRustSource, { recursive: true }, (_event, file) => requestBuild(file, fileName => shouldRebuildAppServer(fileName, watchedTargetDirectory))),
    watch(repositoryRoot, (_event, file) => requestBuild(file, shouldRebuildWorkspaceManifest)),
  );
  console.log('[app-server] Watching Rust App Server sources');
  if (buildRequested) void drainBuilds();
  return stop;

  function requestBuild(file: string | null, shouldRebuild: (file: string | null) => boolean): void {
    if (stopped || !shouldRebuild(file)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      buildRequested = true;
      void drainBuilds();
    }, debounceMs);
  }

  async function drainBuilds(): Promise<void> {
    if (building || stopped) return;
    building = true;
    try {
      while (buildRequested && !stopped) {
        buildRequested = false;
        try {
          await generateProtocol(cancellation.signal);
          cancellation.signal.throwIfAborted();
          await runBackendBuild();
        } catch (error) {
          if (!stopped) console.error(`[app-server] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      building = false;
    }
  }

  function runBackendBuild(): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const { command, args } = pythonCommand(['-B', 'build/ash_rs/develop.py']);
      const child = spawn(command, args, { cwd: repositoryRoot, env: process.env, stdio: 'inherit', windowsHide: true });
      activeBuild = child;
      child.once('error', error => {
        activeBuild = undefined;
        reject(error);
      });
      child.once('close', (code, signal) => {
        activeBuild = undefined;
        if (code === 0) resolvePromise();
        else reject(new Error(signal ? `backend build stopped by ${signal}` : `backend build exited with status ${code ?? 'unknown'}`));
      });
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    cancellation.abort();
    clearTimeout(debounce);
    for (const watcher of watchers) watcher.close();
    activeBuild?.kill('SIGTERM');
  }
}
