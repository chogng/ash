import { type FSWatcher, readFileSync, statSync, watch } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { generateProtocol, protocolSourceDirectories } from '../protocol/generate.ts';
import { runPython } from '../python.ts';
import { LiveBuilder } from './liveBuild.ts';
import { watchNativeFile } from '../lib/watchNativeFile.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const terminalCrates = new Set<string>(JSON.parse(readFileSync(resolve(repositoryRoot, 'build/source-layout.json'), 'utf8')).terminalCrates);
const sharedRustSource = resolve(repositoryRoot, 'crates');
const rustSdkSource = resolve(repositoryRoot, 'sdk/rust');
const configuredTargetDirectory = process.env.CARGO_TARGET_DIR?.trim();
const targetDirectory = resolve(repositoryRoot, configuredTargetDirectory || '.build/cargo');
const debounceMs = 250;

/** Prepare before selecting a runtime: file watchers only observe changes after startup. */
export async function prepareAppServer(javascriptRuntime: 'host-provided-node' | 'packaged-node', signal?: AbortSignal): Promise<void> {
	const commands = [['-B', 'build/prepare.py', '--javascript-runtime', javascriptRuntime]];
	if (javascriptRuntime === 'host-provided-node') commands.push(['-B', 'build/desktop/develop.py', '--select-prepared']);
	for (const arguments_ of commands) {
		await runPython(arguments_, { cwd: repositoryRoot, operation: 'backend preparation', signal });
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

export async function watchAppServer(options: { skipInitial?: boolean; javascriptRuntime?: 'host-provided-node' | 'packaged-node'; onDidBuild?: () => Promise<void>; environment?: NodeJS.ProcessEnv; } = {}): Promise<() => void> {
	let buildRequested = !options.skipInitial;
	let protocolRequested = buildRequested;
	let fullBuildRequired = buildRequested;
	let protocolDirectories: string[] | undefined;
	let manifestRevision = 0;
	let protocolManifestRevision = -1;
	const changedSources = new Set<string>();
	let debounce: NodeJS.Timeout | undefined;
	let stopped = false;
	let building = false;
	const cancellation = new AbortController();
	const watchers: Pick<FSWatcher, 'close'>[] = [];
	const watchStarted = Date.now();
	const observedFiles = new Map<string, string>();
	const environment = options.environment ?? process.env;
	const liveDirectory = options.javascriptRuntime !== 'packaged-node' && environment.ASH_RUST_LIVE_DIRECTORY?.trim();
	const liveBuilder = liveDirectory ? new LiveBuilder(repositoryRoot, environment) : undefined;

	try {
		// The Rust author SDK remains a backend build input after leaving crates/.
		for (const source of [sharedRustSource, rustSdkSource]) {
			const ignoredTarget = relativeWatchedDirectory(source, targetDirectory);
			watchers.push(watch(source, { recursive: true }, (event, file) => requestBuild(source, file, event, fileName => shouldRebuildAppServer(fileName, ignoredTarget))));
		}
		if (process.platform === 'darwin') {
			// libuv filters non-recursive directory events after FSEvents delivers
			// them. A root-directory watch therefore also subscribes to build caches.
			for (const file of ['Cargo.toml', 'Cargo.lock']) {
				watchers.push(watchNativeFile(resolve(repositoryRoot, file), event => requestBuild(repositoryRoot, file, event, shouldRebuildWorkspaceManifest), error => console.error(`[app-server] Manifest watcher failed: ${file}`, error)));
			}
		} else {
			watchers.push(watch(repositoryRoot, (event, file) => requestBuild(repositoryRoot, file, event, shouldRebuildWorkspaceManifest)));
		}
	} catch (error) {
		stop();
		throw error;
	}
	console.log('[app-server] Watching Rust App Server sources');
	if (buildRequested) void drainBuilds();
	return stop;

	function requestBuild(watchRoot: string, file: string | null, event: string, shouldRebuild: (file: string | null) => boolean): void {
		if (stopped || file === null || !shouldRebuild(file)) return;
		const source = resolve(watchRoot, file.replaceAll('\\', '/'));
		if (event === 'change') {
			try {
				// Cargo lock accesses and source reads can emit native change events
				// without a write on macOS as well as Windows.
				// Content writes change ctime even when size/mtime are preserved.
				// Renames and unreadable/deleted inputs always reach the build gate.
				const stat = statSync(source);
				const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
				const previous = observedFiles.get(source);
				observedFiles.set(source, stamp);
				if (stamp === previous || (previous === undefined && stat.mtimeMs < watchStarted && stat.ctimeMs < watchStarted)) return;
			} catch {
				observedFiles.delete(source);
			}
		} else {
			observedFiles.delete(source);
		}
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
				// A timer may have queued this batch while an earlier build ran;
				// newer saves can already be in it with another debounce pending.
				// Consuming those saves must also consume their timer.
				clearTimeout(debounce);
				buildRequested = false;
				const sources = [...changedSources];
				changedSources.clear();
				fullBuildRequired ||= sources.length === 0 || !liveDirectory || sources.some(source => {
					const file = relativeWatchedDirectory(resolve(sharedRustSource, 'app-server-diff/src'), source);
					return file === undefined || !file.endsWith('.rs');
				});
				let needsProtocol = protocolRequested || sources.some(source => source.endsWith(`${sep}Cargo.toml`) || source.endsWith(`${sep}Cargo.lock`));
				protocolRequested = false;
				try {
					// Dependency/protocol builds retire the old semantic database before
					// refreshing Cargo inputs. Adapter-only saves reuse it across edits.
					if (fullBuildRequired) await liveBuilder?.stop();
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
					// Only the stateless adapter has a live producer. Shared algorithms,
					// manifests and protocols may affect other consumers and still rebuild.
					const liveOnly = !fullBuildRequired;
					await runBackendBuild(liveOnly);
					if (!liveOnly) fullBuildRequired = false;
					cancellation.signal.throwIfAborted();
					if (!liveOnly) await options.onDidBuild?.();
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

	async function runBackendBuild(liveOnly: boolean): Promise<void> {
		if (liveOnly && liveBuilder) return liveBuilder.build();
		// Web owns a packaged Node runtime; Electron supplies Node from its host.
		const buildArguments = options.javascriptRuntime === 'packaged-node'
			? ['-B', 'build/prepare.py', '--javascript-runtime', 'packaged-node']
			: ['-B', 'build/desktop/develop.py', '--protocol-prepared'];
		await runPython(buildArguments, { cwd: repositoryRoot, environment, operation: 'backend build', signal: cancellation.signal });
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		cancellation.abort();
		clearTimeout(debounce);
		for (const watcher of watchers) watcher.close();
		void liveBuilder?.stop();
	}
}
