import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { createAppServerSyntaxApi } from '../../../src/ash/platform/syntax/browser/syntaxApi.js';
import { WEB_APP_SERVER_CLOSED_EVENT, type AppServerTransport } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import type { ISyntaxApi } from '../../../src/ash/platform/syntax/common/syntaxApi.js';

declare global {
	interface Window {
		__rustSyntaxTransport(event: string, payload?: unknown): Promise<void>;
		__rustSyntaxEvent(event: string, payload: unknown): void;
	}
}

let connection: Promise<{ api: ISyntaxApi; client: AppServerProtocolClient; }> | undefined;

/** Only the frame carrier is a test bridge; initialization, decoding and syntax use the product client and real Rust process. */
export async function rustSyntaxFixture(): Promise<ISyntaxApi> {
	connection ??= connect();
	return (await connection).api;
}

async function connect(): Promise<{ api: ISyntaxApi; client: AppServerProtocolClient; }> {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	window.__rustSyntaxEvent = (event, payload) => {
		for (const listener of listeners.get(event) ?? []) listener(payload);
	};
	const transport: AppServerTransport = {
		on(event, listener) {
			let callbacks = listeners.get(event);
			if (!callbacks) listeners.set(event, callbacks = new Set());
			callbacks.add(listener);
		},
		off(event, listener) { listeners.get(event)?.delete(listener); },
		send(event, payload) {
			void window.__rustSyntaxTransport(event, payload).catch(error => {
				window.__rustSyntaxEvent(WEB_APP_SERVER_CLOSED_EVENT, { reason: String(error) });
			});
		},
	};
	const client = new AppServerProtocolClient(transport);
	window.addEventListener('pagehide', () => client.dispose(), { once: true });
	try {
		await client.connect();
		return { api: createAppServerSyntaxApi(client), client };
	} catch (error) {
		client.dispose();
		throw error;
	}
}

/** A new connection must rebuild derived syntax from the live dirty buffer. */
export async function disconnectRustSyntaxFixture(): Promise<void> {
	if (!connection) throw new Error('Syntax fixture has not connected');
	(await connection).client.disconnect();
}

export async function reconnectRustSyntaxFixture(): Promise<void> {
	if (!connection) throw new Error('Syntax fixture has not connected');
	const { client } = await connection;
	client.disconnect();
	await client.connect();
}
