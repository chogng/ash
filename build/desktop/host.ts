import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import ts from 'typescript';
import { ProcessRun } from '../processes.ts';
import { desktopBuildPath } from './paths.ts';
import { prepareIncrementalOutput } from '../lib/incrementalOutput.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = repositoryRoot;
const outputRoot = desktopBuildPath(repositoryRoot);
// Invoke TS7's Node launcher, which selects the installed platform executable.
const compiler = join(sourceRoot, 'node_modules/@ash/typescript-compiler/bin/tsc');
const preload = join(outputRoot, 'preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs');
const projects = ['tsconfig.main.json', 'tsconfig.preload.json'] as const;

/** Publish hashes after copying the final desktop assets; package.json cannot hash itself. */
export async function writeApplicationChecksums(applicationRoot: string): Promise<void> {
	const checksums: Record<string, string> = {};
	async function collect(directory: string): Promise<void> {
		const entries = await readdir(join(applicationRoot, directory), { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) {
				await collect(path);
			} else if (entry.isFile()) {
				const hash = createHash('sha256');
				for await (const bytes of createReadStream(join(applicationRoot, path))) {
					hash.update(bytes);
				}
				checksums[path] = hash.digest('hex');
			} else {
				throw new Error(`Application checksum assets must be regular files: ${path}`);
			}
		}
	}
	await collect('dist');
	await collect('resources');
	for (const path of ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html']) {
		if (!Object.hasOwn(checksums, path)) {
			throw new Error(`Application checksum assets omit an entrypoint: ${path}`);
		}
	}
	const metadata = JSON.parse(await readFile(join(applicationRoot, 'package.json'), 'utf8'));
	metadata.checksums = checksums;
	await writeFile(join(applicationRoot, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function prepareHostOutput(): Promise<void> {
	await mkdir(outputRoot, { recursive: true });
	const metadata = '{\n  "private": true,\n  "type": "module"\n}\n';
	const packageFile = join(outputRoot, 'package.json');
	const previous = await readFile(packageFile, 'utf8').catch(error => {
		if (error.code !== 'ENOENT') throw error;
		return undefined;
	});
	// Generated source imports use this package scope; touching unchanged metadata invalidates their compiler cache.
	if (previous !== metadata) await writeFile(packageFile, metadata);
	const link = join(outputRoot, 'node_modules');
	const dependencies = await realpath(join(sourceRoot, 'node_modules'));
	try {
		const metadata = await lstat(link);
		if (!metadata.isSymbolicLink()) throw new Error(`Build dependency path is not a directory link: ${link}`);
		try {
			if ((await realpath(link)) === dependencies) return;
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		await unlink(link);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
	await symlink(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function buildHost(): Promise<void> {
	await prepareHostBuild();
	await new Promise<void>((done, fail) => {
		const child = spawn(process.execPath, [compiler, '--build', ...projects, '--pretty', 'false'], {
			cwd: sourceRoot,
			stdio: 'inherit',
			windowsHide: true,
		});
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`host build ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
		});
	});
	await verifyPreload();
}

/** Successful readiness includes the output content digest used to decide whether Electron needs restarting. */
export async function watchHost(onReady: (ready: boolean, output?: string) => void): Promise<{ close: () => Promise<void>; done: Promise<void> }> {
	await prepareHostBuild();
	const completion = Promise.withResolvers<void>();
	let compilerRun: ProcessRun | undefined;
	let revision = 0;
	let closing: Promise<void> | undefined;
	let building: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let structureTimer: ReturnType<typeof setTimeout> | undefined;
	let pending = true;
	// Keep TS7's dependency-tree FSEvents watcher away from build caches and
	// runtime files. Watch source inputs here and invoke its incremental build once.
	const roots = ['src', '.build/protocol/typescript', '.build/desktop/localization'].map(path => resolve(sourceRoot, path));
	const directories = new Map<string, ts.FileWatcher>();
	const nativeDirectories: FSWatcher[] = [];
	const files = new Map<string, ts.FileWatcher>();
	const observedFiles = new Map<string, string>();
	const builtInputs = new Map<string, { mtime: number; content: string }>();
	const changedInputs = new Set<string>();
	const watchStarted = Date.now();
	try {
		for (const root of process.platform === 'win32' ? roots : []) {
			// Windows timestamp polling cannot see equal-size saves with a restored
			// mtime; native change events also let us compare their content digest.
			const watcher = watch(root, { recursive: true }, (event, file) => {
				if (file === null || event === 'rename' || /\.(?:[cm]?ts|json)$/u.test(file)) requestBuild(file === null ? root : resolve(root, file), event);
			});
			watcher.on('error', error => {
				if (!closing) fail(error);
			});
			nativeDirectories.push(watcher);
		}
		updateFileWatches();
	} catch (error) {
		for (const watcher of [...nativeDirectories, ...directories.values(), ...files.values()]) watcher.close();
		throw error;
	}
	onReady(false);
	startBuild();

	function updateDirectoryWatches(): Set<string> {
		const paths = new Set<string>();
		const inputs = new Set<string>();
		function visit(path: string): void {
			paths.add(path);
			try {
				for (const entry of readdirSync(path, { withFileTypes: true })) {
					if (entry.isDirectory()) visit(join(path, entry.name));
					else if (entry.isFile() && /\.(?:[cm]?ts|json)$/u.test(entry.name)) inputs.add(join(path, entry.name));
				}
			} catch (error) {
				if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
			}
		}
		for (const root of roots) visit(root);
		for (const [path, watcher] of directories) {
			if (!paths.has(path)) {
				watcher.close();
				directories.delete(path);
			}
		}
		for (const path of paths) {
			if (directories.has(path)) continue;
			// Poll directory timestamps for membership changes; native recursive
			// events can miss a newly created subtree or replay initial entries.
			directories.set(
				path,
				ts.sys.watchFile!(
					path,
					() => {
						if (closing) return;
						clearTimeout(structureTimer);
						structureTimer = setTimeout(() => {
							structureTimer = undefined;
							try {
								if (updateFileWatches()) requestBuild(path);
							} catch (error) {
								fail(error);
							}
						}, 100);
					},
					500,
					{ watchFile: ts.WatchFileKind.DynamicPriorityPolling },
				),
			);
		}
		return inputs;
	}

	function updateFileWatches(): boolean {
		// Subscribe before compilation, including imports not listed as tsconfig
		// roots, so a save during the first build cannot escape the pending batch.
		const paths = updateDirectoryWatches();
		for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) paths.add(resolve(sourceRoot, path));
		const readConfig = (path: string): string | undefined => {
			paths.add(resolve(path));
			return ts.sys.readFile(path);
		};
		for (const project of projects) {
			const path = resolve(sourceRoot, project);
			const config = ts.readJsonConfigFile(path, readConfig);
			const parsed = ts.parseJsonSourceFileConfigFileContent(config, { ...ts.sys, readFile: readConfig }, sourceRoot, undefined, path);
			for (const file of parsed.fileNames) paths.add(resolve(file));
		}
		const changed = paths.size !== files.size || [...paths].some(path => !files.has(path));
		for (const [path, watcher] of files) {
			if (!paths.has(path)) {
				watcher.close();
				files.delete(path);
			}
		}
		for (const path of paths) {
			if (process.platform === 'win32' && !builtInputs.has(path)) {
				const input = readInput(path);
				if (input) builtInputs.set(path, input);
			}
			if (!files.has(path))
				files.set(
					path,
					ts.sys.watchFile!(path, () => requestBuild(path, 'change'), 250),
				);
		}
		return changed;
	}

	function requestBuild(path: string, event?: string): void {
		if (closing) return;
		if (process.platform === 'win32' && event === 'change') {
			try {
				// NTFS can report reads as changes. Include ctime so equal-size edits
				// with a restored mtime still invalidate the running build.
				const stat = statSync(path);
				const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
				const previous = observedFiles.get(path);
				observedFiles.set(path, stamp);
				if (stamp === previous || (previous === undefined && stat.mtimeMs < watchStarted && stat.ctimeMs < watchStarted)) return;
			} catch {
				observedFiles.delete(path);
			}
		} else {
			observedFiles.delete(path);
		}
		if (process.platform === 'win32') changedInputs.add(path);
		revision++;
		if (!pending) onReady(false);
		pending = true;
		console.log(`[host] Input changed: ${relative(sourceRoot, path)}`);
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			startBuild();
		}, 100);
	}

	function startBuild(): void {
		if (closing || building) return;
		building = build()
			.catch(fail)
			.finally(() => {
				building = undefined;
				if (!closing && pending && timer === undefined) startBuild();
			});
	}

	async function build(): Promise<void> {
		pending = false;
		// Check settled timestamps after debouncing: a Windows write can report a
		// transient truncation. Compare with the last compiled snapshot, not that
		// notification, before bypassing TS7's mtime-based incremental gate.
		const inputs = new Map<string, { mtime: number; content: string }>();
		for (const path of changedInputs) {
			const input = readInput(path);
			if (input) inputs.set(path, input);
			else builtInputs.delete(path);
		}
		changedInputs.clear();
		const force = [...inputs].some(([path, input]) => {
			const previous = builtInputs.get(path);
			return previous?.mtime === input.mtime && previous.content !== input.content;
		});
		const current = revision;
		console.log('[host] Starting incremental compilation...');
		const run = new ProcessRun(sourceRoot, undefined, 5_000);
		compilerRun = run;
		const child = spawn(process.execPath, [compiler, '--build', ...projects, '--pretty', 'false', ...(force ? ['--force'] : [])], {
			cwd: sourceRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: process.platform !== 'win32',
		});
		const stdout = createInterface({ input: child.stdout });
		const stderr = createInterface({ input: child.stderr });
		stdout.on('line', line => console.log(`[host] ${line}`));
		stderr.on('line', line => console.error(`[host] ${line}`));
		const result = new Promise<boolean>((done, reject) => {
			child.once('error', reject);
			child.once('close', code => {
				stdout.close();
				stderr.close();
				done(code === 0);
			});
		});
		let succeeded: boolean;
		try {
			await run.own(child);
			succeeded = await result;
		} finally {
			await run.close();
			compilerRun = undefined;
		}
		if (closing) return;
		updateFileWatches();
		if (succeeded && current === revision) {
			for (const [path, input] of inputs) builtInputs.set(path, input);
		}
		if (succeeded) await validate(current);
		else if (current === revision) onReady(false);
	}

	function readInput(path: string): { mtime: number; content: string } | undefined {
		try {
			return {
				mtime: statSync(path).mtime.getTime(),
				content: createHash('sha256').update(readFileSync(path)).digest('hex'),
			};
		} catch {
			return undefined;
		}
	}

	async function validate(current: number): Promise<void> {
		if (closing || current !== revision) return;
		try {
			await verifyPreload();
			// Watch notifications can complete a successful build without changing its
			// outputs. Restarting on those notifications can feed back on runtime file writes.
			const hash = createHash('sha256');
			async function collect(directory: string): Promise<void> {
				const entries = await readdir(directory, { withFileTypes: true });
				entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const entry of entries) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) {
						await collect(path);
					} else if (entry.isFile()) {
						hash.update(JSON.stringify([path, await readFile(path, 'utf8')]));
					}
				}
			}
			for (const project of ['main', 'preload']) {
				await collect(join(outputRoot, project));
			}
			const output = hash.digest('hex');
			if (!closing && current === revision) onReady(true, output);
		} catch (error) {
			console.error(`[host] ${error instanceof Error ? error.message : error}`);
			if (!closing && current === revision) onReady(false);
		}
	}

	function fail(error: Error): void {
		completion.reject(error);
		void close();
	}

	function close(): Promise<void> {
		if (closing) return closing;
		clearTimeout(timer);
		clearTimeout(structureTimer);
		for (const watcher of [...nativeDirectories, ...directories.values(), ...files.values()]) watcher.close();
		closing = Promise.resolve(compilerRun?.stop('SIGTERM')).then(async () => {
			await building;
			completion.resolve();
		});
		return closing;
	}

	return { close, done: completion.promise };
}

async function prepareHostBuild(): Promise<void> {
	await prepareHostOutput();
	await Promise.all(projects.map(project => prepareIncrementalOutput(join(sourceRoot, project))));
}

async function verifyPreload(): Promise<void> {
	for (const path of [preload, join(outputRoot, 'preload/src/ash/platform/browserView/electron-browser/preload-browserView.js')]) {
		const source = await readFile(path, 'utf8');
		if (path.endsWith('preload-browserView.js') && /(^|\n)\s*(export|import)\s/.test(source)) {
			throw new Error('Browser preload must be a standalone script');
		}
		const imports = [...source.matchAll(/\brequire\(\s*(["'])(?<module>[^"']+)\1\s*\)/g)].map(match => match.groups?.module);
		if ([...source.matchAll(/\brequire\s*\(/g)].length !== imports.length) {
			throw new Error('Sandbox preload contains a non-literal runtime import');
		}
		const unsupported = imports.filter(module => module !== 'electron');
		if (unsupported.length) throw new Error(`Sandbox preload contains unsupported runtime imports: ${[...new Set(unsupported)].join(', ')}`);
		if (!imports.includes('electron')) throw new Error('Sandbox preload does not import Electron');
		if (/\bimport\s*\(/.test(source)) throw new Error('Sandbox preload contains a dynamic runtime import');
	}
}
