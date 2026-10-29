import type { ElectronApplication, Page } from '@playwright/test';
import type { MessagePortMain } from 'electron';
import { expect, test as baseTest } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';

interface PortBridgeObserver {
	readonly responses: { nonce: string; ports: number; error?: string; fatal?: boolean; }[];
	readonly frames: { nonce: string; data: unknown; }[];
	cancel(nonce: string): void;
	dispose(): void;
}

interface PortBridgePeers {
	readonly ports: MessagePortMain[];
	readonly replies: { nonce: string; data: unknown; }[];
}

interface PortHarness {
	readonly page: Page;
	readonly application: ElectronApplication;
	register(nonces: string[]): Promise<void>;
}

const test = baseTest.extend<{ portHarness: PortHarness; }>({
	portHarness: async ({ target, application, driver }, use) => {
		baseTest.skip(target.kind !== 'electron', 'Requires the Electron sandbox bridge.');
		const electron = application as ElectronApplication;
		const page = driver.currentPage;
		await electron.evaluate(() => { (globalThis as unknown as { portBridgePeers: PortBridgePeers; }).portBridgePeers = { ports: [], replies: [] }; });
		try {
			await use({
				page, application: electron, register: async nonces => {
					await page.evaluate(values => {
						const sandbox = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
						const ports: MessagePort[] = [];
						const subscriptions = new Map(values.map(nonce => [nonce, sandbox.ipcMessagePort.acquire('ash:test:message-port', nonce)]));
						const observer: PortBridgeObserver = {
							responses: [], frames: [],
							cancel: nonce => { subscriptions.get(nonce)?.dispose(); subscriptions.delete(nonce); },
							dispose: () => {
								window.removeEventListener('message', receive);
								for (const subscription of subscriptions.values()) { subscription.dispose(); }
								for (const port of ports) { port.close(); }
							},
						};
						const receive = (event: MessageEvent): void => {
							const data = event.data;
							const nonce = typeof data === 'string' ? data : data?.nonce;
							if (event.source !== window || !values.includes(nonce)) { return; }
							observer.responses.push({ nonce, ports: event.ports.length, ...(typeof data?.error === 'string' ? { error: data.error, fatal: data.fatal } : {}) });
							for (const port of event.ports) {
								ports.push(port);
								port.onmessage = frame => { observer.frames.push({ nonce, data: frame.data }); port.postMessage(`reply-${nonce}`); };
								port.start();
							}
						};
						window.addEventListener('message', receive);
						(globalThis as unknown as { portBridgeObserver: PortBridgeObserver; }).portBridgeObserver = observer;
					}, nonces);
				}
			});
		} finally {
			await page.evaluate(() => (globalThis as unknown as { portBridgeObserver?: PortBridgeObserver; }).portBridgeObserver?.dispose());
			await electron.evaluate(() => {
				for (const port of (globalThis as unknown as { portBridgePeers: PortBridgePeers; }).portBridgePeers.ports) { port.close(); }
			});
		}
	}
});

async function postResponses(
	application: ElectronApplication,
	responses: { nonce: string; port?: boolean; error?: string; fatal?: boolean; stringResponse?: boolean; }[],
): Promise<void> {
	await application.evaluate(({ BrowserWindow, MessageChannelMain }, values) => {
		const renderer = BrowserWindow.getAllWindows()[0].webContents;
		const peers = (globalThis as unknown as { portBridgePeers: PortBridgePeers; }).portBridgePeers;
		for (const response of values) {
			const data = response.stringResponse ? response.nonce : {
				nonce: response.nonce,
				...(response.error ? { error: response.error, fatal: response.fatal } : {}),
			};
			if (!response.port) { renderer.postMessage('ash:test:message-port', data); continue; }
			const { port1, port2 } = new MessageChannelMain();
			peers.ports.push(port1);
			port1.on('message', event => peers.replies.push({ nonce: response.nonce, data: event.data }));
			port1.start();
			renderer.postMessage('ash:test:message-port', data, [port2]);
			port1.postMessage(`frame-${response.nonce}`);
		}
	}, responses);
}

test('sandbox MessagePort bridge matches concurrent nonces and transfers working ports', async ({ portHarness: { application, page, register } }) => {
	await register(['a', 'b']);
	await postResponses(application, [
		{ nonce: 'unrelated' },
		{ nonce: 'b', port: true, stringResponse: true },
		{ nonce: 'a', port: true },
		{ nonce: 'a', error: 'duplicate response' },
	]);
	await expect.poll(() => page.evaluate(() => {
		const observer = (globalThis as unknown as { portBridgeObserver: PortBridgeObserver; }).portBridgeObserver;
		return { responses: observer.responses, frames: [...observer.frames].sort((a, b) => a.nonce.localeCompare(b.nonce)) };
	})).toEqual({ responses: [{ nonce: 'b', ports: 1 }, { nonce: 'a', ports: 1 }], frames: [{ nonce: 'a', data: 'frame-a' }, { nonce: 'b', data: 'frame-b' }] });
	await expect.poll(() => application.evaluate(() => {
		const peers = (globalThis as unknown as { portBridgePeers: PortBridgePeers; }).portBridgePeers;
		return [...peers.replies].sort((a, b) => a.nonce.localeCompare(b.nonce));
	})).toEqual([{ nonce: 'a', data: 'reply-a' }, { nonce: 'b', data: 'reply-b' }]);
});

test('sandbox MessagePort cancellation stops late responses while the next request still completes', async ({ portHarness: { application, page, register } }) => {
	await register(['cancelled', 'current']);
	await page.evaluate(() => (globalThis as unknown as { portBridgeObserver: PortBridgeObserver; }).portBridgeObserver.cancel('cancelled'));
	await postResponses(application, [{ nonce: 'cancelled', error: 'late failure', fatal: true }, { nonce: 'current', port: true }]);
	await expect.poll(() => page.evaluate(() => {
		const observer = (globalThis as unknown as { portBridgeObserver: PortBridgeObserver; }).portBridgeObserver;
		return { responses: observer.responses, frames: observer.frames };
	})).toEqual({ responses: [{ nonce: 'current', ports: 1 }], frames: [{ nonce: 'current', data: 'frame-current' }] });
});

test('sandbox MessagePort failures retain diagnostics without a transferred port', async ({ portHarness: { application, page, register } }) => {
	await register(['failure', 'fatal']);
	await postResponses(application, [{ nonce: 'failure', error: 'connection closed', fatal: false }, { nonce: 'fatal', error: 'host exited', fatal: true }]);
	await expect.poll(() => page.evaluate(() => (globalThis as unknown as { portBridgeObserver: PortBridgeObserver; }).portBridgeObserver.responses)).toEqual([
		{ nonce: 'failure', ports: 0, error: 'connection closed', fatal: false },
		{ nonce: 'fatal', ports: 0, error: 'host exited', fatal: true },
	]);
});
