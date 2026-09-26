import { packager } from '@electron/packager';
import { rebuild } from '@electron/rebuild';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AshApplicationId } from '../../app-ts/src/ash/code/common/application.ts';
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH } from '../../app-ts/src/ash/platform/app-server/common/generated/protocol.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const appRoot = join(repositoryRoot, 'app-ts');
const buildRoot = join(repositoryRoot, '.build', 'app-ts');
const outputRoot = join(repositoryRoot, 'dist');
const arch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : undefined;
const target = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

if (process.platform !== 'darwin' || !arch) throw new Error('macOS packaging requires a macOS arm64 or x64 host');
const options = parseOptions(process.argv.slice(2));
const signingIdentity = process.env.ASH_MACOS_SIGNING_IDENTITY;
const updatePublicKey = process.env.ASH_UPDATE_PUBLIC_KEY;
if (!updatePublicKey || !/^[a-fA-F0-9]{64}$/u.test(updatePublicKey)) throw new Error('ASH_UPDATE_PUBLIC_KEY must be a 64-digit Ed25519 public key');
if (!options.unsigned && !signingIdentity) throw new Error('ASH_MACOS_SIGNING_IDENTITY is required; use --unsigned only for local testing');
const destination = options.output ?? outputRoot;
const bundlePath = join(destination, `Ash-darwin-${arch}`, 'Ash.app');
if (await exists(bundlePath)) throw new Error(`Bundle already exists: ${bundlePath}`);

await runPnpm(['--dir', 'app-ts', 'build:package']);
await mkdir(buildRoot, { recursive: true });
const stage = await mkdtemp(join(buildRoot, 'package-darwin-'));
try {
	const appStage = join(stage, 'app');
	await runPnpm(['--filter', 'ash-desktop', 'deploy', '--prod', '--ignore-scripts', appStage]);
	const metadata = JSON.parse(await readFile(join(appStage, 'package.json'), 'utf8'));
	metadata.main = 'dist/main/src/main.js';
	await writeFile(join(appStage, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
	for (const part of ['main', 'preload', 'renderer']) {
		await cp(join(buildRoot, part), join(appStage, 'dist', part), { recursive: true });
	}
	const electronMetadata = JSON.parse(await readFile(join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
	await rebuild({ buildPath: appStage, electronVersion: electronMetadata.version, platform: 'darwin', arch, onlyModules: ['native-keymap'], force: true });

	const backend = options.backendPackage ?? join(stage, 'backend');
	if (!options.backendPackage) {
		await run(process.env.PYTHON ?? 'python3', [
			'-B', join(repositoryRoot, 'build', 'ash_rs', 'build.py'),
			'--target', target,
			'--javascript-runtime', 'host-provided-node',
			'--package-dir', backend,
		], repositoryRoot);
	}
	await validateBackend(backend);
	await run('cargo', ['build', '--release', '--target', target, '-p', 'ash-product-update', '--bin', 'ash-update-host'], repositoryRoot);
	const cargoTarget = resolve(repositoryRoot, process.env.CARGO_TARGET_DIR ?? '.build/cargo');
	const updateBin = join(stage, 'bin');
	await cp(join(backend, 'bin'), updateBin, { recursive: true });
	await cp(join(cargoTarget, target, 'release', 'ash-update-host'), join(updateBin, 'ash-update-host'), { errorOnExist: true, force: false });
	const updateKeyFile = join(stage, 'update-public-key');
	await writeFile(updateKeyFile, `${updatePublicKey.toLowerCase()}\n`, { flag: 'wx' });
	const resources = [...(await readdir(backend)).filter(entry => entry !== '.lease' && entry !== 'bin').map(entry => join(backend, entry)), updateBin, updateKeyFile];
	await mkdir(destination, { recursive: true });
	const packages = await packager({
		dir: appStage,
		out: destination,
		name: 'Ash',
		executableName: 'Ash',
		appBundleId: AshApplicationId,
		platform: 'darwin',
		arch,
		electronVersion: electronMetadata.version,
		icon: join(repositoryRoot, 'resources', 'darwin', 'ash.icns'),
		asar: false,
		prune: false,
		derefSymlinks: true,
		extraResource: resources,
		...(options.unsigned ? {} : { osxSign: { identity: signingIdentity! } }),
		ignore: path => {
			const [top, second] = path.slice(1).split('/');
			if (!top) return false;
			if (!['package.json', 'node_modules', 'dist', 'THIRD_PARTY_NOTICES.md'].includes(top)) return true;
			return top === 'node_modules' && ['.bin', 'electron'].includes(second);
		},
	});
	if (packages.length !== 1 || resolve(packages[0]) !== dirname(bundlePath)) throw new Error('Electron packager returned an unexpected bundle path');
	for (const file of [
		'Contents/MacOS/Ash',
		'Contents/Resources/app/package.json',
		'Contents/Resources/app/dist/main/src/main.js',
		'Contents/Resources/app/dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs',
		'Contents/Resources/app/dist/renderer/ash/electron-browser/workbench/workbench.html',
		'Contents/Resources/ash-package.json',
		'Contents/Resources/bin/ash-app-server',
		'Contents/Resources/bin/ash-update-host',
		'Contents/Resources/update-public-key',
	]) await lstat(join(bundlePath, file));
	if (!options.unsigned) await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundlePath], repositoryRoot);
	console.log(`Packaged macOS application: ${bundlePath}`);
} finally {
	const [root, directory] = await Promise.all([realpath(buildRoot), realpath(stage)]);
	if (dirname(directory) !== root || !basename(directory).startsWith('package-darwin-')) throw new Error(`Packaging stage is outside the build directory: ${directory}`);
	await rm(directory, { recursive: true, force: true });
}

function parseOptions(args: readonly string[]): { readonly backendPackage?: string; readonly output?: string; readonly unsigned: boolean } {
	let backendPackage: string | undefined;
	let output: string | undefined;
	let unsigned = false;
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === '--unsigned' && !unsigned) { unsigned = true; continue; }
		if (option === '--backend-package' && !backendPackage && args[index + 1]) { backendPackage = resolve(args[++index]!); continue; }
		if (option === '--output' && !output && args[index + 1]) { output = resolve(args[++index]!); continue; }
		throw new Error(`Invalid macOS package option: ${option}`);
	}
	return { backendPackage, output, unsigned };
}

async function validateBackend(path: string): Promise<void> {
	const metadata = JSON.parse(await readFile(join(path, 'ash-package.json'), 'utf8'));
	const application = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	if (metadata.target !== target || metadata.javascriptRuntime?.kind !== 'hostProvidedNode'
		|| metadata.layoutVersion !== 2 || metadata.version !== application.version
		|| metadata.entrypoint !== 'bin/ash-app-server'
		|| metadata.protocol?.major !== APP_SERVER_PROTOCOL_MAJOR
		|| metadata.protocol?.revision !== APP_SERVER_PROTOCOL_REVISION
		|| metadata.protocol?.schemaHash !== APP_SERVER_SCHEMA_HASH
		|| typeof metadata.buildId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(metadata.buildId)
		|| !/^[a-f0-9]{64}$/u.test(metadata.components?.appServer?.binarySha256)
		|| !/^[a-f0-9]{64}$/u.test(metadata.components?.appServerDaemon?.binarySha256)) {
		throw new Error(`Backend does not match this macOS desktop build: ${path}`);
	}
	await lstat(join(path, metadata.entrypoint));
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

async function runPnpm(args: string[]): Promise<void> {
	const pnpm = process.env.npm_execpath;
	if (!pnpm) throw new Error('Run macOS packaging through the pnpm package script');
	if (/\.[cm]?js$/iu.test(pnpm)) await run(process.execPath, [pnpm, ...args], repositoryRoot);
	else await run(pnpm, args, repositoryRoot);
}

async function run(program: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(program, args, { cwd, stdio: 'inherit', windowsHide: true });
		child.once('error', fail);
		child.once('close', (code, signal) => code === 0 ? done() : fail(new Error(`${program} ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`)));
	});
}
