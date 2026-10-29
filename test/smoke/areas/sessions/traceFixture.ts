import type { Page } from '@playwright/test';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';

/** Acquires another initialized connection to the product's owning daemon. */
export async function connectTraceAppServer(application: PlaywrightApplication, page: Page, workspaceDirectory: string): Promise<{ client: AppServerProtocolClient; close(): Promise<void>; }> {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const pendingMethods = new Map<number, string>();
	const emit = (event: string, value: unknown): void => {
		if (event === WEB_APP_SERVER_FRAME_EVENT) {
			const frame = JSON.parse((value as { frame: string; }).frame);
			if (frame.error) { console.error(`Trace fixture RPC ${pendingMethods.get(frame.id)} failed: ${JSON.stringify(frame.error)}`); }
			if (frame.id !== undefined) { pendingMethods.delete(frame.id); }
		}
		for (const listener of listeners.get(event) ?? []) { listener(value); }
	};
	let frames: ChildProcessJsonlTransport | undefined;
	let launcher: ReturnType<typeof createAppServerDaemonLauncher>['launcher'] | undefined;
	let frameSubscription: { dispose(): void; } | undefined;
	let closeSubscription: { dispose(): void; } | undefined;
	if ('evaluate' in application) {
		const host = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, electronExecutable: process.execPath, profileRoot: process.env.ASH_HOME!, sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ASH_RG_PATH: process.env.ASH_RG_PATH, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH } }));
		({ launcher } = createAppServerDaemonLauncher({ ...host, packageLocation: { appPath: host.appPath, resourcesPath: host.resourcesPath, isPackaged: false, platform: process.platform }, workspaceRoot: workspaceDirectory, role: 'agents' }));
		await launcher.validate();
		frames = new ChildProcessJsonlTransport(launcher.launch());
		frameSubscription = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		closeSubscription = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
	} else {
		await page.exposeFunction('ashTraceFixtureFrame', (frame: string) => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		await page.evaluate(async () => {
			const endpoint = new URL('/ash/app-server', sessionStorage.getItem('ash.appServer.endpoint')!);
			const token = sessionStorage.getItem(`ash.appServer.session:${endpoint.origin}`)!;
			endpoint.protocol = 'ws:';
			const socket = new WebSocket(endpoint, `ash-session.${token}`);
			const fixture = globalThis as typeof globalThis & { ashTraceFixtureSocket?: WebSocket; ashTraceFixtureFrame(frame: string): Promise<void>; };
			fixture.ashTraceFixtureSocket = socket;
			socket.onmessage = event => { void fixture.ashTraceFixtureFrame(String(event.data)); };
			await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Trace fixture connection failed')); });
		});
	}
	const client = new AppServerProtocolClient({
		on(event, listener) { let group = listeners.get(event); if (!group) { group = new Set(); listeners.set(event, group); } group.add(listener); },
		off(event, listener) { listeners.get(event)?.delete(listener); },
		send(event, value) {
			if (event === WEB_APP_SERVER_CONNECT_EVENT) { emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'trace-fixture', workspaceRoot: workspaceDirectory }); }
			else if (event === WEB_APP_SERVER_FRAME_EVENT) {
				const frame = (value as { frame: string; }).frame;
				const request = JSON.parse(frame);
				if (typeof request.id === 'number' && typeof request.method === 'string') { pendingMethods.set(request.id, request.method); }
				const sent = frames ? frames.send(frame) : page.evaluate(frame => (globalThis as typeof globalThis & { ashTraceFixtureSocket: WebSocket; }).ashTraceFixtureSocket.send(frame), frame);
				void sent.catch(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: String(error) }));
			} else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) { throw new Error(`Unexpected trace fixture event ${event}`); }
		},
	});
	const close = async (): Promise<void> => {
		client.dispose(); frameSubscription?.dispose(); closeSubscription?.dispose();
		listeners.clear(); pendingMethods.clear();
		await frames?.close(); launcher?.dispose();
		if (!frames && !page.isClosed()) { await page.evaluate(() => (globalThis as typeof globalThis & { ashTraceFixtureSocket?: WebSocket; }).ashTraceFixtureSocket?.close()); }
	};
	try { await client.connect(); return { client, close }; }
	catch (error) { await close(); throw error; }
}
