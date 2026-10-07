import { type ChildProcess, spawn } from 'node:child_process';
import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { generateProtocol, protocolSourceDirectories } from '../protocol/generate.ts';
import { pythonCommand } from '../python.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const terminalCrates = new Set<string>(JSON.parse(readFileSync(resolve(repositoryRoot, 'build/source-layout.json'), 'utf8')).terminalCrates);
const sharedRustSource = resolve(repositoryRoot, 'crates');
const configuredTargetDirectory = process.env.CARGO_TARGET_DIR?.trim();
const targetDirectory = resolve(repositoryRoot, configuredTargetDirectory || '.build/cargo');
const watchedTargetDirectory = relativeWatchedDirectory(sharedRustSource, targetDirectory);
const debounceMs = 250;

/** Prepare before selecting a runtime: file watchers only observe changes after startup. */
export async function prepareAppServer(javascriptRuntime: 'host-provided-node' | 'packaged-node'): Promise<void> {
	const commands = [['-B', 'build/prepare.py', '--javascript-runtime', javascriptRuntime]];
	if (javascriptRuntime === 'host-provided-node') commands.push(['-B', 'build/desktop/develop.py', '--select-prepared']);
	for (const arguments_ of commands) {
		const { command, args } = pythonCommand(arguments_);
		await new Promise<void>((resolvePromise, reject) => {
			const child = spawn(command, args, { cwd: repositoryRoot, env: process.env, stdio: 'inherit', windowsHide: true });
			child.once('error', reject);
			child.once('close', (code, signal) => {
				if (code === 0) resolvePromise();
				else reject(new Error(signal ? `backend preparation stopped by ${signal}` : `backend preparation exited with status ${code ?? 'unknown'}`));
			});
		});
	}
}

export function shouldRebuildAppServer(file: string | null, ignoredDirectory?: string): boolean {
	if (typeof file !== 'string') return false;
	const normalized = file.replaceAll('\\', '/');
	if (terminalCrates.has(normalized.split('/')[0])) return false;
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

export async function watchAppServer(options: { skipInitial?: boolean; javascriptRuntime?: 'host-provided-node' | 'packaged-node'; onDidBuild?: () => Promise<void>; } = {}): Promise<() => void> {
	let activeBuild: ChildProcess | undefined;
	let buildRequested = !options.skipInitial;
	let protocolRequested = buildRequested;
	let protocolDirectories: string[] | undefined;
	let manifestRevision = 0;
	let protocolManifestRevision = -1;
	const changedSources = new Set<string>();
	let debounce: NodeJS.Timeout | undefined;
	let stopped = false;
	let building = false;
	const cancellation = new AbortController();
	const watchers: FSWatcher[] = [];

	watchers.push(
		watch(sharedRustSource, { recursive: true }, (_event, file) => requestBuild(sharedRustSource, file, fileName => shouldRebuildAppServer(fileName, watchedTargetDirectory))),
		watch(repositoryRoot, (_event, file) => requestBuild(repositoryRoot, file, shouldRebuildWorkspaceManifest)),
	);
	console.log('[app-server] Watching Rust App Server sources');
	if (buildRequested) void drainBuilds();
	return stop;

	function requestBuild(watchRoot: string, file: string | null, shouldRebuild: (file: string | null) => boolean): void {
		if (stopped || file === null || !shouldRebuild(file)) return;
		const source = resolve(watchRoot, file.replaceAll('\\', '/'));
		changedSources.add(source);
		if (source.endsWith(`${sep}Cargo.toml`) || source.endsWith(`${sep}Cargo.lock`)) manifestRevision++;
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
				const sources = [...changedSources];
				changedSources.clear();
				let needsProtocol = protocolRequested || sources.some(source => source.endsWith(`${sep}Cargo.toml`) || source.endsWith(`${sep}Cargo.lock`));
				protocolRequested = false;
				try {
					if (protocolDirectories === undefined || protocolManifestRevision !== manifestRevision) {
						const revision = manifestRevision;
						protocolDirectories = await protocolSourceDirectories(cancellation.signal);
						protocolManifestRevision = revision;
					}
					// Snapshot each batch before awaiting: saves during a build belong to the next one.
					const directories = protocolDirectories;
					needsProtocol ||= sources.some(source => directories.some(directory => relativeWatchedDirectory(directory, source) !== undefined));
					if (needsProtocol) {
						await generateProtocol(cancellation.signal);
						needsProtocol = false;
					}
					cancellation.signal.throwIfAborted();
					await runBackendBuild();
					cancellation.signal.throwIfAborted();
					await options.onDidBuild?.();
				} catch (error) {
					// A failed export must be retried before the next backend build, even for a business save.
					protocolRequested ||= needsProtocol || protocolDirectories === undefined || protocolManifestRevision !== manifestRevision;
					if (!stopped) console.error(`[app-server] ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} finally {
			building = false;
		}
	}

	function runBackendBuild(): Promise<void> {
		return new Promise<void>((resolvePromise, reject) => {
			// Web owns a packaged Node runtime; Electron supplies Node from its host.
			const buildArguments = options.javascriptRuntime === 'packaged-node'
				? ['-B', 'build/prepare.py', '--javascript-runtime', 'packaged-node']
				: ['-B', 'build/desktop/develop.py'];
			const { command, args } = pythonCommand(buildArguments);
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
