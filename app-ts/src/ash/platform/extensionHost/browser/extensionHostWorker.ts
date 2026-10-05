import type { BrowserExtensionHostRequest } from './extensionHostApi.js';
import type { ExtensionHostRegistration, JsonValue } from '../common/extensionHostApi.js';

type Handler = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue> | JsonValue;
const handlers = new Map<string, Handler>();
const invocations = new Map<number, AbortController>();
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<BrowserExtensionHostRequest>) => void; postMessage(value: unknown): void };

scope.onmessage = event => {
	const message = event.data;
	if (message.type === 'cancel') { invocations.get(message.invocationId)?.abort(); return; }
	void dispatch(message).then(result => scope.postMessage({ id: message.id, success: true, result }), error => scope.postMessage({ id: message.id, success: false, error: String(error) }));
};

async function dispatch(message: Exclude<BrowserExtensionHostRequest, { type: 'cancel' }>): Promise<JsonValue> {
	if (message.type === 'activate') {
		const registrations: ExtensionHostRegistration[] = [];
		// Packages supply a bundled ES module; no module executes in the renderer's JavaScript realm.
		const extension = await import(/* @vite-ignore */ message.entryPoint);
		await extension.activate({
			register(registration: ExtensionHostRegistration, handler: Handler): void {
				if (handlers.has(registration.registrationId)) { throw new Error(`Duplicate extension registration: ${registration.registrationId}`); }
				handlers.set(registration.registrationId, handler);
				registrations.push(registration);
			},
		});
		return registrations as unknown as JsonValue;
	}
	const handler = handlers.get(message.request.registrationId);
	if (!handler) { throw new Error('Browser extension registration does not exist'); }
	const controller = new AbortController();
	invocations.set(message.id, controller);
	try { return await handler(message.request.operation, message.request.payload, controller.signal); }
	finally { invocations.delete(message.id); }
}
