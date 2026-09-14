import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { developmentAshPackagePath } from '../../src/ash/platform/environment/node/developmentArtifacts.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../src/ash/platform/workspaces/electron-main/appServerWorkspaceTransition.js';

const desktopDirectory = resolve(import.meta.dirname, '../..');

/** Grants the isolated smoke workspace before Electron asks through a native OS dialog. */
export async function prepareDirectoryPermissions(profileRoot: string, workspaceDirectory: string): Promise<void> {
	const packageRoot = developmentAshPackagePath(desktopDirectory);
	const executable = join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-app-server.exe' : 'ash-app-server');
	const backend = spawn(executable, ['--listen', 'stdio://'], {
		env: { ...process.env, ASH_HOME: profileRoot },
		stdio: 'pipe',
	});
	let stderr = '';
	backend.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
	const output = createInterface({ input: backend.stdout });
	const lines = output[Symbol.asyncIterator]();
	let id = 0;
	const request = async (method: string, params: unknown): Promise<unknown> => {
		const requestId = ++id;
		backend.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
		for (;;) {
			const line = await withTimeout(lines.next(), 15_000);
			if (line.done) throw new Error(`App Server closed while preparing directory permissions: ${stderr}`);
			const response: unknown = JSON.parse(line.value);
			if (typeof response !== 'object' || response === null || !('id' in response) || response.id !== requestId) continue;
			if ('error' in response) throw new Error(`Could not prepare directory permissions: ${JSON.stringify(response.error)}`);
			if (!('result' in response)) throw new Error('App Server returned no result while preparing directory permissions');
			return response.result;
		}
	};
	try {
		await request('initialize', { clientInfo: { name: 'ash-smoke', version: '1' }, capabilities: { dirPermissionsHost: { version: 1 } } });
		const config = await request('config/read', {});
		if (typeof config !== 'object' || config === null || !('revision' in config) || typeof config.revision !== 'number') {
			throw new Error('App Server did not return a configuration revision');
		}
		await request('config/dirPermissions/set', {
			commandId: 'smoke-workspace-permissions',
			expectedRevision: config.revision,
			path: await realpath(workspaceDirectory),
			permissions: DEVELOPMENT_DIR_PERMISSIONS,
		});
		const exited = once(backend, 'exit');
		backend.stdin.end();
		await withTimeout(exited, 15_000);
	} finally {
		output.close();
		if (backend.exitCode === null && backend.signalCode === null) {
			const exited = once(backend, 'exit');
			backend.kill();
			await exited;
		}
	}
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('App Server permission setup timed out')), milliseconds); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
