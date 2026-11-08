import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { developmentAshPackagePath } from '../../../build/desktop/runtimeStore.ts';
import models from './dictation.json' with { type: 'json' };
import { startDictationFixtureServer } from './server.ts';

const root = resolve(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== '--fail-once')) {
	throw new Error('Usage: pnpm dev:dictation-test [--fail-once]');
}

// Use a separate renderer port so the fixture can run beside a regular dev instance.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const rendererPort = (probe.address() as AddressInfo).port;
await new Promise<void>((done, fail) => probe.close(error => error ? fail(error) : done()));

const directory = await mkdtemp(join(tmpdir(), 'ash-dictation-test-'));
const profile = join(directory, 'profile');
let server: Awaited<ReturnType<typeof startDictationFixtureServer>> | undefined;
try {
	await mkdir(profile);
	await writeFile(join(profile, 'settings.json'), JSON.stringify({ 'dictation.backend': 'local', 'dictation.model': models[0].id }));
	server = await startDictationFixtureServer(args.includes('--fail-once'));
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		ASH_DEV_SUBSECOND: '0',
		ASH_DEV_AGENTS_WINDOW: '1',
		ASH_DEV_APP_SERVER_RELOAD: '1',
		ASH_DEV_DICTATION_CATALOG: join(import.meta.dirname, 'dictation.json'),
		ASH_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
		ASH_HOME: profile,
	};
	// The fixture should always use the prepared development runtime and its own profile.
	delete environment.ASH_DEV_APP_SERVER_GENERATION;
	delete environment.ASH_DESKTOP_UI_ONLY;
	delete environment.ASH_RUST_LIVE_DIRECTORY;
	const child = spawn(process.execPath, [
		'build/desktop/launch/electron.ts', '--watch', '--dev-services', `--user-data-dir=${join(directory, 'user-data')}`,
	], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
	const interrupt = () => child.kill('SIGINT');
	const terminate = () => child.kill('SIGTERM');
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		const [code, signal] = await once(child, 'exit');
		process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
		let daemon: string | undefined;
		try {
			daemon = join(developmentAshPackagePath(root), 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
		} catch {
			// Preparation may have failed before there was a backend to stop.
		}
		if (daemon) await promisify(execFile)(daemon, ['stop'], { env: environment, timeout: 30_000, windowsHide: true });
	}
} finally {
	server?.closeAllConnections();
	server?.close();
	await rm(directory, { recursive: true, force: true });
}
