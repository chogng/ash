import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pythonCommand } from '../python.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const require = createRequire(join(repositoryRoot, 'package.json'));
const addons = [
	{ name: 'native-keymap', binary: 'keymapping.node', exports: ['getKeyMap', 'getCurrentKeyboardLayout', 'onDidChangeKeyboardLayout'] },
	...process.platform === 'win32' ? [{ name: 'native-is-elevated', binary: 'iselevated.node', exports: ['isElevated'] }] : [],
];

// Load the binding directly: both upstream JS wrappers hide load errors. Do not
// read a layout or subscribe here; CI may have no interactive desktop session.
const probe = `
const [file, expectedVersion, expectedArch, ...exports] = process.argv.slice(1);
if (process.versions.electron !== expectedVersion || process.arch !== expectedArch) throw new Error('Unexpected Electron runtime');
const binding = require(file);
for (const name of exports) {
  if (typeof binding[name] !== 'function') throw new Error('Missing addon export: ' + name);
}
`;

/** Validate with the actual host; only missing or unloadable bindings reach the compiler. */
export async function prepareElectronAddons(applicationRoot: string, options: { force?: boolean; } = {}): Promise<void> {
	const electron: string = require('electron');
	const { version } = require('electron/package.json');
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version)) throw new Error('Invalid Electron package version');
	const applicationRequire = createRequire(join(applicationRoot, 'package.json'));
	for (const addon of addons) {
		const packageRoot = dirname(applicationRequire.resolve(`${addon.name}/package.json`));
		const binary = join(packageRoot, 'build/Release', addon.binary);
		const fingerprint = await sourceFingerprint(packageRoot);
		const cache = join(repositoryRoot, '.build/desktop-addons/v1', `${process.platform}-${process.arch}`, version, `${addon.name}-${fingerprint}.json`);
		const validate = async (): Promise<void> => {
			await new Promise<void>((done, fail) => {
				childProcess.execFile(electron, ['-e', probe, binary, version, process.arch, ...addon.exports], {
					cwd: applicationRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
				}, error => error ? fail(error) : done());
			});
		};
		let available = false;
		if (!options.force) {
			try { await validate(); available = true; } catch { /* Try the exact source/runtime cache before rebuilding. */ }
			if (!available && await restoreBinding(cache, binary)) {
				try { await validate(); available = true; } catch { /* A load failure also invalidates cached artifacts. */ }
			}
		}
		if (!available) {
			console.log(`[desktop-addons] Building ${addon.name} for Electron ${version} (${process.platform}-${process.arch})`);
			// A successful .forge-meta check cannot repair a corrupt/missing binding.
			// Force applies only after our runtime probe fails, or on explicit request.
			const { rebuild } = await import('@electron/rebuild');
			// electron-rebuild's node-gyp worker discovers Python through the environment.
			// Share the repository interpreter used by the other preparation steps.
			const previousPython = process.env.PYTHON;
			process.env.PYTHON = pythonCommand([]).command;
			try {
				await rebuild({ buildPath: applicationRoot, electronVersion: version, platform: process.platform, arch: process.arch, onlyModules: [addon.name], force: true, disablePreGypCopy: true });
			} finally {
				if (previousPython === undefined) delete process.env.PYTHON;
				else process.env.PYTHON = previousPython;
			}
			await validate();
		}
		await cacheBinding(cache, binary);
	}
}

async function sourceFingerprint(packageRoot: string): Promise<string> {
	const hash = createHash('sha256');
	async function collect(directory: string): Promise<void> {
		const entries = await readdir(join(packageRoot, directory), { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
		for (const entry of entries) {
			// Rebuild output and pnpm links must not invalidate their own cache.
			if (entry.name === 'node_modules' || (!directory && ['build', 'bin'].includes(entry.name))) continue;
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await collect(path);
			else if (entry.isFile()) hash.update(JSON.stringify([path, digest(await readFile(join(packageRoot, path)))]));
			else throw new Error(`Addon source must be a regular file or directory: ${path}`);
		}
	}
	await collect('');
	return hash.digest('hex');
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

async function restoreBinding(cache: string, binary: string): Promise<boolean> {
	let record: unknown;
	try { record = JSON.parse(await readFile(cache, 'utf8')); } catch (error) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
		throw error;
	}
	if (!record || typeof record !== 'object' || !('data' in record) || typeof record.data !== 'string' || !('sha256' in record) || typeof record.sha256 !== 'string') return false;
	const bytes = Buffer.from(record.data, 'base64');
	if (!bytes.length || digest(bytes) !== record.sha256) return false;
	await publish(binary, bytes);
	return true;
}

async function cacheBinding(cache: string, binary: string): Promise<void> {
	const bytes = await readFile(binary);
	const record = JSON.stringify({ sha256: digest(bytes), data: bytes.toString('base64') });
	try { if (await readFile(cache, 'utf8') === record) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
	await publish(cache, record);
}

async function publish(path: string, content: Buffer | string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content);
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 1 || args[0] !== '--force')) throw new Error('Usage: addons.ts [--force]');
	await prepareElectronAddons(repositoryRoot, { force: args[0] === '--force' });
}
