import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { decodeWebListenInfo, decodeWebSessionInfo } from '../../src/ash/platform/app-server/common/generated/WebProtocolDecoder.ts';
import { developmentAshPackagePath } from '../../../build/app_ts/runtimeStore.ts';

const desktopDirectory = resolve(import.meta.dirname, '../..');
const mode = process.argv[2];
const playwrightArguments = process.argv.slice(3);
if (mode !== 'disconnected' && mode !== 'full') {
	throw new Error('Usage: node test/smoke/browser.ts <disconnected|full>');
}

if (mode === 'full') {
	const python = ['run', '--frozen', '--project', '../scripts', 'python', '-B', '../build/ash_rs/prepare.py'];
	const preparation = await run('uv', [
		...python,
		'--javascript-runtime',
		'packaged-node',
	], process.env);
	if (preparation !== 0) {
		process.exitCode = preparation;
		process.exit();
	}
}

const build = await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', '../build/app_ts/vite/vite.config.ts'], { ...process.env, ASH_WEB_APP_SERVER: mode === 'full' ? '1' : '0' });
if (build !== 0) process.exit(build);

const port = mode === 'full' ? 5174 : 5173;
const serverUrl = `http://127.0.0.1:${port}/`;
const workspaceDirectory = mode === 'full'
	? await mkdtemp(join(tmpdir(), 'ash-playwright-browser-workspace-'))
	: undefined;
const profileDirectory = mode === 'full'
	// Leave room for the daemon's socket name within Windows AF_UNIX limits.
	? await mkdtemp(join(tmpdir(), 'ash-web-'))
	: undefined;
const productServicesPath = profileDirectory ? join(profileDirectory, 'product-services.json') : undefined;
let languageServerExecutable = process.env.ASH_PLAYWRIGHT_RUST_ANALYZER;
if (profileDirectory && !languageServerExecutable) {
	languageServerExecutable = join(
		profileDirectory,
		process.platform === 'win32' ? 'ash-test-language-server.exe' : 'ash-test-language-server',
	);
	const compilation = await run('rustc', [
		'--edition=2024',
		'test/fixtures/language-server.rs',
		'-o',
		languageServerExecutable,
	], process.env);
	if (compilation !== 0) {
		process.exitCode = compilation;
		process.exit();
	}
}
if (profileDirectory && languageServerExecutable) {
	await writeFile(
		join(profileDirectory, 'config.toml'),
		`[languageServers.servers.rust-analyzer]\nmode = "enabled"\nexecutable = ${JSON.stringify(languageServerExecutable)}\n`,
		'utf8',
	);
}
if (productServicesPath) {
	await writeFile(productServicesPath, '{"schemaVersion":2}\n', 'utf8');
}
const testEnvironment = workspaceDirectory ? {
	...process.env,
	ASH_PLAYWRIGHT_WORKSPACE: workspaceDirectory,
	ASH_PLAYWRIGHT_PROFILE: profileDirectory,
	...(productServicesPath ? { ASH_PRODUCT_SERVICES_PATH: productServicesPath } : {}),
	...(languageServerExecutable ? { ASH_PLAYWRIGHT_LANGUAGE_SERVER: languageServerExecutable } : {}),
} : process.env;
const serverEnvironment = mode === 'full' ? {
	...testEnvironment,
	ASH_WEB_APP_SERVER: '1',
	ASH_WORKSPACE_ROOT: workspaceDirectory,
	...(profileDirectory ? { ASH_WEB_APP_SERVER_PROFILE: profileDirectory } : {}),
	...(productServicesPath ? { ASH_PRODUCT_SERVICES_PATH: productServicesPath } : {}),
} : testEnvironment;
const server = spawn(process.execPath, [
	'../scripts/app_ts/web.ts',
	'../.build/app-ts/renderer/ash',
	String(port),
], {
	cwd: desktopDirectory,
	env: serverEnvironment,
	stdio: ['ignore', 'pipe', 'inherit'],
});

const webSession = mode === 'full' ? new Promise<string>((resolveSession, reject) => {
	const lines = createInterface({ input: server.stdout! });
	const timeout = setTimeout(() => { lines.close(); reject(new Error('Missing Web launch record')); }, 35_000);
	lines.once('line', line => {
		clearTimeout(timeout); lines.close();
		void (async () => {
			const info = decodeWebListenInfo(JSON.parse(line));
			const response = await fetch(new URL('/ash/session', info.endpoint), { method: 'POST', headers: { Origin: new URL(info.endpoint).origin }, body: info.ticket, signal: AbortSignal.timeout(10_000) });
			if (!response.ok) { throw new Error('Web test authentication failed'); }
			return JSON.stringify({ endpoint: info.endpoint, session: decodeWebSessionInfo(await response.json()) });
		})().then(resolveSession, reject);
	});
	server.once('error', reject);
}) : Promise.resolve(undefined);

let exitCode = 1;
try {
	const session = await webSession;
	await waitForServer(serverUrl, server);
	const project = mode === 'full' ? 'browser-app-server' : 'browser-ui';
	exitCode = await run(process.execPath, [
		'node_modules/@playwright/test/cli.js',
		'test',
		`--project=${project}`,
		...playwrightArguments,
	], {
		...process.env,
		...testEnvironment,
		ASH_PLAYWRIGHT_SERVER: mode,
		ASH_SMOKE_BROWSER_EXTERNAL_SERVER: '1',
		...(session ? { ASH_PLAYWRIGHT_WEB_SESSION: session } : {}),
	});
} finally {
	await stop(server);
	if (profileDirectory) {
		const packageRoot = developmentAshPackagePath(resolve(desktopDirectory, '..'), 'packaged-node');
		const daemon = join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
		const result = await run(daemon, ['stop'], { ...serverEnvironment, ASH_HOME: profileDirectory });
		if (result !== 0) throw new Error(`Could not stop the test profile's App Server: ${result}`);
	}
	if (workspaceDirectory) {
		await rm(workspaceDirectory, { force: true, recursive: true });
	}
	if (profileDirectory) {
		await rm(profileDirectory, { force: true, recursive: true });
	}
}

process.exitCode = exitCode;

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Web integration server exited with code ${child.exitCode}`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) {
				return;
			}
		} catch {}
		await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
	}
	throw new Error(`Web integration server did not become ready at ${url}`);
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise<number>((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: desktopDirectory, env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) {
				reject(new Error(`Web integration command exited with signal ${signal}`));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>(resolvePromise => {
		const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
		child.once('close', () => { clearTimeout(timeout); resolvePromise(); });
		child.kill('SIGTERM');
	});
}
