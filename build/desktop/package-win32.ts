import { packager } from '@electron/packager';
import { writeApplicationChecksums } from './host.ts';
import { ignoreApplicationFile, prepareProductionDependencyWorkspace, productionDependencyDeployOptions } from './packageApplication.ts';
import { pruneElectronLocales } from './packageLocales.ts';
import { prepareElectronAddons } from './addons.ts';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AshApplicationId } from '../../src/ash/code/common/application.ts';
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH } from '../../.build/protocol/typescript/protocol.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const appRoot = repositoryRoot;
const buildRoot = join(repositoryRoot, '.build', 'desktop');
const outputRoot = join(repositoryRoot, 'dist');
const icon = join(repositoryRoot, 'resources', 'win32', 'ash.ico');
const bundledApplication = join(outputRoot, 'Ash-win32-x64');
const python = join(repositoryRoot, 'scripts', '.venv', 'Scripts', 'python.exe');

const [command, ...arguments_] = process.argv.slice(2);
if (command === 'bundle') await bundle(parseOptions(arguments_, ['--backend-package', '--output', '--remote-release']));
else if (command === 'installer') await installer(parseOptions(arguments_, ['--bundle', '--output']));
else throw new Error('Usage: package-win32.ts bundle [--backend-package DIR] [--output DIR] | installer [--bundle DIR] [--output DIR]');

function parseOptions(args: string[], allowed: readonly string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!allowed.includes(key) || !value || options.has(key)) throw new Error(`Invalid package option: ${key}`);
		options.set(key, resolve(value));
	}
	return options;
}

async function bundle(options: Map<string, string>): Promise<void> {
	requireWindows();
	const destination = options.get('--output') ?? outputRoot;
	const bundlePath = join(destination, 'Ash-win32-x64');
	if (await exists(bundlePath)) throw new Error(`Bundle already exists: ${bundlePath}`);

	await runPnpm(['app-icon:check']);
	await runPnpm(['build:package']);

	await mkdir(buildRoot, { recursive: true });
	const stage = await mkdtemp(join(buildRoot, 'package-win32-'));
	try {
		await assembleBundle(stage, bundlePath, options);
	} finally {
		const [root, directory] = await Promise.all([realpath(buildRoot), realpath(stage)]);
		if (dirname(directory) !== root || !basename(directory).startsWith('package-win32-')) {
			throw new Error(`Packaging stage is outside the build directory: ${directory}`);
		}
		await rm(directory, { recursive: true, force: true });
	}
}

async function assembleBundle(stage: string, bundlePath: string, options: Map<string, string>): Promise<void> {
	const remoteRelease = options.get('--remote-release') ?? process.env.ASH_REMOTE_RELEASE_BINDING;
	if (!remoteRelease) throw new Error('Remote release binding is required: --remote-release FILE or ASH_REMOTE_RELEASE_BINDING');
	const updatePublicKey = requireUpdatePublicKey();
	const destination = dirname(bundlePath);
	const appStage = join(stage, 'app');
	const dependencySource = join(stage, 'dependencies');
	await prepareProductionDependencyWorkspace(repositoryRoot, dependencySource);
	await runPnpm([...productionDependencyDeployOptions, appStage], dependencySource);

	const metadata = JSON.parse(await readFile(join(appStage, 'package.json'), 'utf8'));
	metadata.main = 'dist/main/src/main.js';
	await writeFile(join(appStage, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
	for (const part of ['main', 'preload', 'renderer']) {
		await cp(join(buildRoot, part), join(appStage, 'dist', part), { recursive: true });
	}
	await cp(join(repositoryRoot, 'resources', 'tray'), join(appStage, 'resources', 'tray'), { recursive: true });

	const electronMetadata = JSON.parse(await readFile(join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
	await lstat(python);
	process.env.NODE_GYP_FORCE_PYTHON = python;
	await prepareElectronAddons(appStage);

	await writeApplicationChecksums(appStage);

	const sourceBackend = options.get('--backend-package') ?? await buildBackend(stage, electronMetadata.version);
	const backend = join(stage, 'desktop-backend');
	await run(python, ['-B', join(repositoryRoot, 'build', 'desktop', 'package_runtime.py'), '--source', sourceBackend, '--output', backend, '--electron-version', electronMetadata.version, '--remote-release', resolve(remoteRelease)], repositoryRoot);
	await validateBackend(backend, electronMetadata.version);

	await mkdir(destination, { recursive: true });
	const packagePaths = await packager({
		dir: appStage,
		out: destination,
		name: 'Ash',
		executableName: 'Ash',
		platform: 'win32',
		arch: 'x64',
		electronVersion: electronMetadata.version,
		icon,
		asar: false,
		prune: false,
		derefSymlinks: true,
		ignore: path => ignoreApplicationFile(path),
		afterExtract: [pruneElectronLocales],
	});
	if (packagePaths.length !== 1 || resolve(packagePaths[0]) !== bundlePath) throw new Error('Electron packager returned an unexpected bundle path');

	const resources = join(bundlePath, 'resources');
	for (const entry of await readdir(backend)) {
		if (entry === '.lease') continue;
		await cp(join(backend, entry), join(resources, entry), { recursive: true, errorOnExist: true, force: false });
	}
	const updateArtifact = join(stage, 'update-host.json');
	await run(python, [
		'-B', join(repositoryRoot, 'build', 'release', 'symbols.py'), 'build-update-host',
		'--target', 'x86_64-pc-windows-msvc', '--artifact-file', updateArtifact,
	], repositoryRoot);
	const updateHost: string = JSON.parse(await readFile(updateArtifact, 'utf8')).binary;
	await cp(updateHost, join(resources, 'bin', 'ash-update-host.exe'), { errorOnExist: true, force: false });
	if (process.env.ASH_SYMBOLS_DIR) {
		await run(python, [
			'-B', join(repositoryRoot, 'build', 'release', 'symbols.py'), 'collect',
			'--binary', updateHost,
			'--staged', join(resources, 'bin', 'ash-update-host.exe'), '--target', 'x86_64-pc-windows-msvc',
		], repositoryRoot);
	}
	await writeFile(join(resources, 'update-public-key'), `${updatePublicKey}\n`, { flag: 'wx' });
	await validateBundle(bundlePath);
	console.log(`Packaged Windows application: ${bundlePath}`);
}

async function buildBackend(stage: string, electronVersion: string): Promise<string> {
	const backend = join(stage, 'backend');
	await run(python, [
		'-B', join(repositoryRoot, 'build', 'app_server.py'),
		'--target', 'x86_64-pc-windows-msvc',
		'--javascript-runtime', 'host-provided-node',
		'--media-distribution', 'bundled',
		'--electron-version', electronVersion,
		'--package-dir', backend,
		'--capability-archive-dir', join(repositoryRoot, '.build', 'releases'),
	], repositoryRoot);
	return backend;
}

async function validateBackend(path: string, electronVersion: string): Promise<void> {
	const metadata = JSON.parse(await readFile(join(path, 'ash-package.json'), 'utf8'));
	const application = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	if (metadata.target !== 'x86_64-pc-windows-msvc' || metadata.javascriptRuntime?.kind !== 'hostProvidedNode'
		|| metadata.javascriptRuntime.electronVersion !== electronVersion || metadata.components?.node !== undefined
		|| metadata.components?.remoteServer !== undefined || typeof metadata.remoteRuntimeCatalog?.url !== 'string'
		|| metadata.layoutVersion !== 2 || metadata.version !== application.version
		|| metadata.entrypoint !== 'bin/ash-app-server.exe'
		|| metadata.protocol?.major !== APP_SERVER_PROTOCOL_MAJOR
		|| metadata.protocol?.schemaHash !== APP_SERVER_SCHEMA_HASH
		|| typeof metadata.buildId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(metadata.buildId)
		|| !/^[a-f0-9]{64}$/u.test(metadata.components?.appServer?.binarySha256)
		|| !/^[a-f0-9]{64}$/u.test(metadata.components?.appServerDaemon?.binarySha256)) {
		throw new Error(`Backend does not match this Windows desktop build: ${path}`);
	}
	await lstat(join(path, metadata.entrypoint));
	for (const relative of ['ash-resources/node', 'ash-resources/licenses/node', 'bin/ash-remote-server.exe', 'ash-remote-runtimes']) {
		if (await exists(join(path, relative))) throw new Error(`Desktop backend contains a separately distributed runtime: ${relative}`);
	}
}

async function validateBundle(path: string): Promise<void> {
	for (const file of [
		'Ash.exe',
		'resources/app/package.json',
		'resources/app/dist/main/src/main.js',
		'resources/app/dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs',
		'resources/app/dist/renderer/ash/electron-browser/workbench/workbench.html',
		'resources/app/resources/tray/ash-black-16.png',
		'resources/app/resources/tray/ash-black-24.png',
		'resources/app/resources/tray/ash-black-32.png',
		'resources/app/resources/tray/ash-white-16.png',
		'resources/app/resources/tray/ash-white-24.png',
		'resources/app/resources/tray/ash-white-32.png',
		'resources/ash-package.json',
		'resources/bin/ash-app-server.exe',
		'resources/bin/ash-update-host.exe',
		'resources/update-public-key',
	]) await lstat(join(path, file));
}

function requireUpdatePublicKey(): string {
	const key = process.env.ASH_UPDATE_PUBLIC_KEY;
	if (!key || !/^[a-fA-F0-9]{64}$/u.test(key)) throw new Error('ASH_UPDATE_PUBLIC_KEY must be a 64-digit Ed25519 public key');
	return key.toLowerCase();
}

async function installer(options: Map<string, string>): Promise<void> {
	requireWindows();
	const bundle = options.get('--bundle') ?? bundledApplication;
	await validateBundle(bundle);
	const output = options.get('--output') ?? outputRoot;
	await mkdir(output, { recursive: true });
	const compiler = process.env.ISCC_PATH ?? 'ISCC.exe';
	const metadata = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	await run(compiler, [
		`/DBundleDir=${bundle}`,
		`/DAppVersion=${metadata.version}`,
		`/DAppUserId=${AshApplicationId}`,
		`/DIconPath=${icon}`,
		`/O${output}`,
		join(import.meta.dirname, 'win32', 'ash.iss'),
	], repositoryRoot);
	console.log(`Packaged Windows installer: ${join(output, `AshSetup-${metadata.version}-win32-x64.exe`)}`);
}

function requireWindows(): void {
	if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 packaging requires a Windows x64 host');
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function runPnpm(args: string[], cwd = repositoryRoot): Promise<void> {
	const pnpm = process.env.npm_execpath;
	if (!pnpm) throw new Error('Run Windows packaging through the pnpm package script');
	if (/\.[cm]?js$/iu.test(pnpm)) await run(process.execPath, [pnpm, ...args], cwd);
	else await run(pnpm, args, cwd);
}

async function run(program: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(program, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, PYTHON: python } });
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`${program} ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
		});
	});
}
