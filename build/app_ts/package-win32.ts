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
const icon = join(repositoryRoot, 'resources', 'win32', 'ash.ico');
const bundledApplication = join(outputRoot, 'Ash-win32-x64');
const python = join(repositoryRoot, 'scripts', '.venv', 'Scripts', 'python.exe');

const [command, ...arguments_] = process.argv.slice(2);
if (command === 'bundle') await bundle(parseOptions(arguments_, ['--backend-package', '--output']));
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
  await runPnpm(['--dir', 'app-ts', 'build:package']);

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
  const destination = dirname(bundlePath);
  const appStage = join(stage, 'app');
  await runPnpm(['--filter', 'ash-desktop', 'deploy', '--prod', '--ignore-scripts', appStage]);

  const metadata = JSON.parse(await readFile(join(appStage, 'package.json'), 'utf8'));
  metadata.main = 'dist/main/src/main.js';
  await writeFile(join(appStage, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  for (const part of ['main', 'preload', 'renderer']) {
    await cp(join(buildRoot, part), join(appStage, 'dist', part), { recursive: true });
  }

  const electronMetadata = JSON.parse(await readFile(join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
  await lstat(python);
  process.env.NODE_GYP_FORCE_PYTHON = python;
  await rebuild({
    buildPath: appStage,
    electronVersion: electronMetadata.version,
    platform: 'win32',
    arch: 'x64',
    onlyModules: ['native-keymap'],
    force: true,
  });

  const backend = options.get('--backend-package') ?? await buildBackend(stage);
  await validateBackend(backend);

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
    // Packager passes POSIX-style paths relative to appStage (for example, /node_modules/pkg).
    ignore: path => {
      const [top, second] = path.slice(1).split('/');
      if (!top) return false;
      if (!['package.json', 'node_modules', 'dist', 'THIRD_PARTY_NOTICES.md'].includes(top)) return true;
      return top === 'node_modules' && ['.bin', 'electron'].includes(second);
    },
  });
  if (packagePaths.length !== 1 || resolve(packagePaths[0]) !== bundlePath) throw new Error('Electron packager returned an unexpected bundle path');

  const resources = join(bundlePath, 'resources');
  for (const entry of await readdir(backend)) {
    if (entry === '.lease') continue;
    await cp(join(backend, entry), join(resources, entry), { recursive: true, errorOnExist: true, force: false });
  }
  await validateBundle(bundlePath);
  console.log(`Packaged Windows application: ${bundlePath}`);
}

async function buildBackend(stage: string): Promise<string> {
  const backend = join(stage, 'backend');
  await run(python, [
    '-B', join(repositoryRoot, 'build', 'ash_rs', 'build.py'),
    '--target', 'x86_64-pc-windows-msvc',
    '--javascript-runtime', 'host-provided-node',
    '--package-dir', backend,
  ], repositoryRoot);
  return backend;
}

async function validateBackend(path: string): Promise<void> {
  const metadata = JSON.parse(await readFile(join(path, 'ash-package.json'), 'utf8'));
  const application = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
  if (metadata.target !== 'x86_64-pc-windows-msvc' || metadata.javascriptRuntime?.kind !== 'hostProvidedNode'
    || metadata.layoutVersion !== 2 || metadata.version !== application.version
    || metadata.entrypoint !== 'bin/ash-app-server.exe'
    || metadata.protocol?.major !== APP_SERVER_PROTOCOL_MAJOR
    || metadata.protocol?.revision !== APP_SERVER_PROTOCOL_REVISION
    || metadata.protocol?.schemaHash !== APP_SERVER_SCHEMA_HASH
    || typeof metadata.buildId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(metadata.buildId)
    || !/^[a-f0-9]{64}$/u.test(metadata.components?.appServer?.binarySha256)
    || !/^[a-f0-9]{64}$/u.test(metadata.components?.appServerDaemon?.binarySha256)) {
    throw new Error(`Backend does not match this Windows desktop build: ${path}`);
  }
  await lstat(join(path, metadata.entrypoint));
}

async function validateBundle(path: string): Promise<void> {
  for (const file of [
    'Ash.exe',
    'resources/app/package.json',
    'resources/app/dist/main/src/main.js',
    'resources/app/dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs',
    'resources/app/dist/renderer/ash/electron-browser/workbench/workbench.html',
    'resources/ash-package.json',
    'resources/bin/ash-app-server.exe',
  ]) await lstat(join(path, file));
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

async function runPnpm(args: string[]): Promise<void> {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run Windows packaging through the pnpm package script');
  if (/\.[cm]?js$/iu.test(pnpm)) await run(process.execPath, [pnpm, ...args], repositoryRoot);
  else await run(pnpm, args, repositoryRoot);
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
