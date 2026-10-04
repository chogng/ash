import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { startWeb } from '../../../build/app_ts/web.ts';
import { developmentAshPackagePath } from '../../../build/app_ts/runtimeStore.ts';
import { decodeWebSessionInfo } from '../../src/ash/platform/app-server/common/generated/WebProtocolDecoder.ts';
import { createTestEnvironment } from './testEnvironment.js';

export interface WebLaunchResult {
	readonly connection: { readonly endpoint: string; readonly token: string };
	close(): Promise<void>;
}

/** Owns the authenticated Web backend and profile for one smoke scenario. */
export async function launchWeb(workspaceDirectory: string, productServices: { readonly reportIssueUrl?: string } = {}): Promise<WebLaunchResult> {
	const root = resolve(import.meta.dirname, '../../..');
	const profileDirectory = await mkdtemp(join(tmpdir(), 'ash-w-'));
	const productServicesPath = join(profileDirectory, 'product-services.json');
	const environment = {
		...createTestEnvironment(profileDirectory, process.env),
		ASH_WEB_APP_SERVER_PROFILE: profileDirectory,
		ASH_WORKSPACE_ROOT: workspaceDirectory,
		ASH_PRODUCT_SERVICES_PATH: productServicesPath,
	};
	let launch: Awaited<ReturnType<typeof startWeb>> | undefined;
	const close = async (): Promise<void> => {
		try {
			await launch?.close();
		} finally {
			try {
				const packageRoot = developmentAshPackagePath(root, 'packaged-node');
				const daemon = join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
				await promisify(execFile)(daemon, ['stop'], { env: { ...environment, ASH_HOME: profileDirectory }, windowsHide: true, timeout: 30_000 });
			} finally {
				await rm(profileDirectory, { force: true, recursive: true });
			}
		}
	};
	try {
		await writeFile(productServicesPath, JSON.stringify({ schemaVersion: 2, ...productServices }) + '\n');
		const languageServer = process.env.ASH_PLAYWRIGHT_LANGUAGE_SERVER;
		if (languageServer) {
			await writeFile(join(profileDirectory, 'config.toml'), `[languageServers.servers.rust-analyzer]\nmode = "enabled"\nexecutable = ${JSON.stringify(languageServer)}\n`);
		}
		launch = await startWeb({ port: 0, assets: join(root, '.build/app-ts/renderer/ash'), environment });
		const { endpoint, ticket } = launch.info;
		const response = await fetch(new URL('/ash/session', endpoint), { method: 'POST', headers: { Origin: new URL(endpoint).origin }, body: ticket, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) { throw new Error(`Web test authentication failed: ${response.status}`); }
		const session = decodeWebSessionInfo(await response.json());
		return { connection: { endpoint, token: session.token }, close };
	} catch (error) {
		await close();
		throw error;
	}
}
