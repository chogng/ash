import type { BrowserExtensionHostRequest } from './extensionHostApi.js';
import type { ExtensionHostRegistration, JsonValue } from '../common/extensionHostApi.js';

type Handler = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue> | JsonValue;
const handlers = new Map<string, Handler>();
const invocations = new Map<number, AbortController>();
const commands = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void; }>();
let nextCommand = 1;
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<BrowserExtensionHostRequest>) => void; postMessage(value: unknown): void; };

scope.onmessage = event => {
	const message = event.data;
	if (message.type === 'commandResult') {
		const command = commands.get(message.id);
		commands.delete(message.id);
		if (message.success) command?.resolve(message.result); else command?.reject(new Error(message.error));
		return;
	}
	if (message.type === 'cancel') { invocations.get(message.invocationId)?.abort(); return; }
	void dispatch(message).then(result => scope.postMessage({ id: message.id, success: true, result }), error => scope.postMessage({ id: message.id, success: false, error: String(error) }));
};

async function dispatch(message: Exclude<BrowserExtensionHostRequest, { type: 'cancel' | 'commandResult'; }>): Promise<JsonValue> {
	if (message.type === 'activate') {
		const registrations: ExtensionHostRegistration[] = [];
		// Packages supply a bundled ES module; no module executes in the renderer's JavaScript realm.
		const extension = await import(/* @vite-ignore */ message.entryPoint);
		await extension.activate({
			language: message.language,
			createWebviewResource(content: string, mediaType: 'text/javascript' | 'text/css'): string {
				if (typeof content !== 'string' || content.length > 16 * 1024 * 1024 || !['text/javascript', 'text/css'].includes(mediaType)) {
					throw new TypeError('Invalid extension webview resource');
				}
				const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
				// The window owns revocation, including abrupt Worker retirement.
				scope.postMessage({ type: 'webviewResource', url });
				return url;
			},
			clientRequest(request: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
				signal?.throwIfAborted();
				const id = nextCommand++;
				return new Promise((resolve, reject) => {
					const abort = (): void => { commands.delete(id); scope.postMessage({ type: 'clientCancel', id }); reject(signal!.reason); };
					signal?.addEventListener('abort', abort, { once: true });
					commands.set(id, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
					scope.postMessage({ type: 'clientRequest', id, request });
				});
			},
			executeCommand(command: string, ...args: readonly JsonValue[]): Promise<JsonValue> {
				const id = nextCommand++;
				return new Promise((resolve, reject) => {
					commands.set(id, { resolve, reject });
					scope.postMessage({ type: 'executeCommand', id, command, args });
				});
			},
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
