import type { BrowserContext, Page } from '@playwright/test';

interface MainChannelTestClient {
	call<T>(channel: string, command: string, arg?: unknown): Promise<T>;
	listen<T>(channel: string, event: string, listener: (value: T) => void): { dispose(): void; };
}

declare global {
	var ashTestMainProcess: MainChannelTestClient;
}

const contexts = new WeakSet<BrowserContext>();

/** Test setup uses the document's real connection without reconnecting or replacing product services. */
export async function installMainChannelTestClient(page: Page): Promise<void> {
	const context = page.context();
	if (!contexts.has(context)) {
		await context.addInitScript(initializeMainChannelTestClient);
		contexts.add(context);
	}
	await page.evaluate(initializeMainChannelTestClient);
}

function initializeMainChannelTestClient(): void {
	if (globalThis.ashTestMainProcess) { return; }
	// Product request IDs grow from 1; test requests use the opposite end of the safe-integer range.
	let sequence = Number.MAX_SAFE_INTEGER;
	const bridge = () => (globalThis as unknown as {
		ash: {
			ipcRenderer: {
				send(channel: string, value: unknown): void;
				on(channel: string, listener: (value: Uint8Array) => void): { dispose(): void; };
			};
		};
	}).ash.ipcRenderer;
	const send = (packet: object): void => bridge().send('ash:message', new TextEncoder().encode(JSON.stringify(packet)));
	const receive = (id: number, listener: (packet: { type: string; data?: unknown; error?: { name: string; message: string; }; }) => void) => bridge().on('ash:message', value => {
		const packet = JSON.parse(new TextDecoder().decode(value));
		if (packet.id === id) { listener(packet); }
	});
	globalThis.ashTestMainProcess = {
		call<T>(channel: string, command: string, arg?: unknown): Promise<T> {
			const id = sequence--;
			return new Promise<T>((resolve, reject) => {
				const subscription = receive(id, packet => {
					if (packet.type !== 'result' && packet.type !== 'error') { return; }
					subscription.dispose();
					if (packet.error) { reject(Object.assign(new Error(packet.error.message), { name: packet.error.name })); }
					else { resolve(packet.data as T); }
				});
				try { send({ type: 'call', id, channel, name: command, arg }); }
				catch (error) { subscription.dispose(); reject(error); }
			});
		},
		listen<T>(channel: string, event: string, listener: (value: T) => void) {
			const id = sequence--;
			const subscription = receive(id, packet => {
				if (packet.type === 'event') { listener(packet.data as T); }
				else if (packet.error) { throw new Error(packet.error.message); }
			});
			send({ type: 'listen', id, channel, name: event });
			return { dispose() { subscription.dispose(); send({ type: 'unsubscribe', id }); } };
		},
	};
}
