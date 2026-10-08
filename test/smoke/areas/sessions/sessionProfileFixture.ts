import type { Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.js';
import { createTestEnvironment } from '../../../automation/testEnvironment.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { WebLaunchResult } from '../../../automation/playwrightWeb.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { decodeWebSessionInfo } from '../../../../.build/protocol/typescript/WebProtocolDecoder.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';

// Each scenario shares its product's real profile daemon. This extra connection
// seeds durable facts through the public API and is released before fixture cleanup.
export async function connectProfile(application: PlaywrightApplication, web: WebLaunchResult | undefined, workspaceRoot: string, source: Page, options: { readonly directoryPermissionsHost?: boolean; } = {}): Promise<{ client: AppServerProtocolClient; close(): Promise<void>; }> {
	if (web && !options.directoryPermissionsHost) {
		// Browser authentication and socket upgrades require the exact Origin. Keep
		// this fixture's independent connection in the real browser realm.
		const session = decodeWebSessionInfo(await source.evaluate(async ({ endpoint, token }) => {
			const response = await fetch(new URL('/ash/session', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '', signal: AbortSignal.timeout(10_000) });
			if (!response.ok) throw new Error(`Fixture authentication failed: ${response.status}`);
			return response.json();
		}, web.connection));
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emit = (event: string, payload: unknown): void => { for (const listener of listeners.get(event) ?? []) listener(payload); };
		let active = true;
		// The binding follows the fixture page lifetime; close clears all transport listeners.
		await source.exposeBinding('agenthostSessionFixtureFrame', (_, payload: { frame?: string; closed?: boolean; }) => {
			if (!active) return;
			if (payload.frame !== undefined) emit(WEB_APP_SERVER_FRAME_EVENT, { frame: payload.frame });
			else if (payload.closed) emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Session fixture socket closed' });
		});
		const client = new AppServerProtocolClient({
			on(event, listener) { let group = listeners.get(event); if (!group) listeners.set(event, group = new Set()); group.add(listener); },
			off(event, listener) { listeners.get(event)?.delete(listener); },
			send(event, payload) {
				if (event === WEB_APP_SERVER_CONNECT_EVENT) {
					void source.evaluate(async ({ endpoint, token }) => {
						const url = new URL('/ash/app-server', endpoint); url.protocol = 'ws:';
						const socket = new WebSocket(url, `ash-session.${token}`);
						const fixture = window as Window & { agenthostSessionFixtureSocket?: WebSocket; agenthostSessionFixtureFrame?: (payload: { frame?: string; closed?: boolean; }) => Promise<void>; };
						const receive = fixture.agenthostSessionFixtureFrame;
						if (!receive) throw new Error('Session fixture binding is missing');
						fixture.agenthostSessionFixtureSocket = socket;
						socket.addEventListener('message', event => { if (typeof event.data === 'string') void receive({ frame: event.data }); });
						socket.addEventListener('close', () => { void receive({ closed: true }); });
						await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Session fixture socket failed')), { once: true }); });
					}, { endpoint: web.connection.endpoint, token: session.token }).then(() => emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: session.workspaceId, workspaceRoot: session.workspaceRoot }), error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) }));
				} else if (event === WEB_APP_SERVER_FRAME_EVENT) {
					void source.evaluate(frame => (window as Window & { agenthostSessionFixtureSocket?: WebSocket; }).agenthostSessionFixtureSocket!.send(frame), (payload as { frame: string; }).frame).catch(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) }));
				} else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) { throw new Error(`Unexpected session fixture event ${event}`); }
			},
		});
		const close = async (): Promise<void> => {
			active = false; client.dispose(); listeners.clear();
			if (!source.isClosed()) await source.evaluate(() => {
				const fixture = window as Window & { agenthostSessionFixtureSocket?: WebSocket; };
				fixture.agenthostSessionFixtureSocket?.close(); delete fixture.agenthostSessionFixtureSocket;
			});
		};
		try { await client.connect(); } catch (error) { await close(); throw error; }
		return { client, close };
	}
	if (!web && !('evaluate' in application)) throw new Error('Expected an Electron profile');
	// Directory grants belong to a trusted host. Web fixtures seed them through
	// Node's local stdio connection; the browser connection keeps its usual rights.
	const webPackage = web ? developmentAshPackagePath(resolve(import.meta.dirname, '../../../..'), 'packaged-node') : undefined;
	const host = web ? {
		appPath: webPackage!, resourcesPath: webPackage!, electronExecutable: process.execPath,
		profileRoot: web.profileDirectory, sourceEnvironment: { ...createTestEnvironment(web.profileDirectory, process.env), ASH_PRODUCT_SERVICES_PATH: join(web.profileDirectory, 'product-services.json') },
	} : await (application as Extract<PlaywrightApplication, { evaluate: unknown }>).evaluate(({ app }) => ({
		appPath: app.getAppPath(), resourcesPath: process.resourcesPath, electronExecutable: process.execPath,
		profileRoot: process.env.ASH_HOME!, sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ASH_RG_PATH: process.env.ASH_RG_PATH, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH },
	}));
	const { launcher } = createAppServerDaemonLauncher({ ...host, packageLocation: { appPath: host.appPath, resourcesPath: host.resourcesPath, isPackaged: !!web, platform: process.platform }, workspaceRoot, role: options.directoryPermissionsHost ? 'workbench' : 'agents' });
	let frames: ChildProcessJsonlTransport | undefined;
	let client: AppServerProtocolClient | undefined;
	let incoming: { dispose(): void; } | undefined;
	let closed: { dispose(): void; } | undefined;
	const close = async (): Promise<void> => {
		client?.dispose(); incoming?.dispose(); closed?.dispose();
		try { await frames?.close(); } finally { launcher.dispose(); }
	};
	try {
		await launcher.validate();
		frames = new ChildProcessJsonlTransport(launcher.launch());
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emit = (event: string, payload: unknown): void => { for (const listener of listeners.get(event) ?? []) listener(payload); };
		incoming = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		closed = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
		client = new AppServerProtocolClient({
			on(event, listener) { let group = listeners.get(event); if (!group) listeners.set(event, group = new Set()); group.add(listener); },
			off(event, listener) { listeners.get(event)?.delete(listener); },
			send(event, payload) {
				if (event === WEB_APP_SERVER_CONNECT_EVENT) emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'session-fixture', workspaceRoot });
				else if (event === WEB_APP_SERVER_FRAME_EVENT) { void frames!.send((payload as { frame: string; }).frame); }
				else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) throw new Error(`Unexpected session fixture event ${event}`);
			},
		}, { capabilities: options.directoryPermissionsHost ? { dirPermissionsHost: { version: 1 } } : {} });
		await client.connect();
		return { client, close };
	} catch (error) { await close(); throw error; }
}
