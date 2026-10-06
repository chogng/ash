import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { appTsBuildPath } from './paths.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = join(repositoryRoot, 'app-ts');
const outputRoot = appTsBuildPath(repositoryRoot);
const compiler = join(sourceRoot, 'node_modules/typescript/bin/tsc');
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
	await writeFile(join(outputRoot, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n');
	const link = join(outputRoot, 'node_modules');
	const dependencies = await realpath(join(sourceRoot, 'node_modules'));
	try {
		const metadata = await lstat(link);
		if (!metadata.isSymbolicLink()) throw new Error(`Build dependency path is not a directory link: ${link}`);
		try {
			if (await realpath(link) === dependencies) return;
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
			cwd: sourceRoot, stdio: 'inherit', windowsHide: true,
		});
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`host build ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
		});
	});
	await verifyPreload();
}

export async function watchHost(onReady: (ready: boolean) => void): Promise<{ close: () => Promise<void>; done: Promise<void>; }> {
	await prepareHostBuild();
	const completion = Promise.withResolvers<void>();
	let revision = 0;
	let closing: Promise<void> | undefined;

	const child = spawn(process.execPath, [compiler, '--build', ...projects, '--watch', '--preserveWatchOutput', '--pretty', 'false'], {
		cwd: sourceRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
	});
	const stdout = createInterface({ input: child.stdout });
	const stderr = createInterface({ input: child.stderr });
	stdout.on('line', line => {
		console.log(`[host] ${line}`);
		if (/Starting compilation in watch mode|File change detected\. Starting incremental compilation/u.test(line)) {
			revision++;
			onReady(false);
			return;
		}
		const result = line.match(/Found (\d+) errors?\. Watching for file changes\./u);
		if (!result) return;
		if (Number(result[1]) > 0) { onReady(false); return; }
		void validate(revision);
	});
	stderr.on('line', line => console.error(`[host] ${line}`));
	child.once('error', fail);
	child.once('close', (code, signal) => {
		stdout.close();
		stderr.close();
		if (!closing) fail(new Error(`host watcher ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
	});

	async function validate(current: number): Promise<void> {
		if (closing || current !== revision) return;
		try {
			await verifyPreload();
			if (!closing && current === revision) onReady(true);
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
		closing = new Promise<void>(done => {
			if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
			const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
			child.once('close', () => { clearTimeout(timeout); done(); });
			child.kill('SIGTERM');
		}).then(() => { completion.resolve(); });
		return closing;
	}

	return { close, done: completion.promise };
}

async function prepareHostBuild(): Promise<void> {
	await prepareHostOutput();
	// TypeScript trusts persisted build info even when outputs have been removed.
	// Start each compiler with a full emit; subsequent watch builds remain incremental.
	await Promise.all(['main.tsbuildinfo', 'preload.tsbuildinfo'].map(file => rm(join(outputRoot, file), { force: true })));
}

async function verifyPreload(): Promise<void> {
	const source = await readFile(preload, 'utf8');
	const imports = [...source.matchAll(/\brequire\(\s*(["'])(?<module>[^"']+)\1\s*\)/g)].map(match => match.groups?.module);
	if ([...source.matchAll(/\brequire\s*\(/g)].length !== imports.length) {
		throw new Error('Sandbox preload contains a non-literal runtime import');
	}
	const unsupported = imports.filter(module => module !== 'electron');
	if (unsupported.length) throw new Error(`Sandbox preload contains unsupported runtime imports: ${[...new Set(unsupported)].join(', ')}`);
	if (!imports.includes('electron')) throw new Error('Sandbox preload does not import Electron');
	if (/\bimport\s*\(/.test(source)) throw new Error('Sandbox preload contains a dynamic runtime import');
}
