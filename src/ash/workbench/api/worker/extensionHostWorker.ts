import type { BrowserExtensionHostRequest } from '../../services/extensions/common/extensionHostProtocol.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';

interface BrowserRuntime {
	activate(): Promise<JsonValue>;
	invoke(id: string, payload: JsonValue, requestId: number, operation: string): Promise<JsonValue>;
	cancel(id: number): void;
	deactivate(): Promise<void>;
}
let runtime: BrowserRuntime | undefined;
const invocations = new Map<number, AbortController>();
let currentInvocation: number | undefined;
// Bundled extensions downlevel await to Promise.then. Each continuation carries its
// originating invocation, including concurrent callbacks and cancelled late replies.
const originalThen = Promise.prototype.then;
Promise.prototype.then = function <TResult1 = unknown, TResult2 = never>(
	fulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
	rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
	const owner = currentInvocation;
	const bind = <TResult>(
		callback: ((value: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
	): typeof callback =>
		callback &&
		function (value: unknown): TResult | PromiseLike<TResult> {
			const previous = currentInvocation;
			currentInvocation = owner;
			try {
				return callback(value);
			} finally {
				currentInvocation = previous;
			}
		};
	return originalThen.call(this, bind(fulfilled), bind(rejected)) as Promise<TResult1 | TResult2>;
};
const commands = new Map<
	number,
	{ request: JsonValue; sent: boolean; resolve(value: JsonValue): void; reject(error: Error): void }
>();
let sentCommands = 0;
let nextCommand = 1;
const scope = globalThis as unknown as {
	onmessage: (event: MessageEvent<BrowserExtensionHostRequest>) => void;
	postMessage(value: unknown): void;
};

scope.onmessage = event => {
	const message = event.data;
	if (message.type === 'commandResult') {
		const command = commands.get(message.id);
		commands.delete(message.id);
		if (command?.sent) sentCommands--;
		if (message.success) command?.resolve(message.result);
		else command?.reject(new Error(message.error));
		pumpClientRequests();
		return;
	}
	if (message.type === 'cancel') {
		invocations.get(message.invocationId)?.abort();
		runtime?.cancel(message.invocationId);
		return;
	}
	void dispatch(message).then(
		result => scope.postMessage({ id: message.id, success: true, result }),
		error => scope.postMessage({ id: message.id, success: false, error: String(error) }),
	);
};

async function dispatch(
	message: Exclude<BrowserExtensionHostRequest, { type: 'cancel' | 'commandResult' }>,
): Promise<JsonValue> {
	if (message.type === 'activate') {
		const globals = globalThis as unknown as Record<string, unknown>;
		globals.__ashConfiguration = message.configuration;
		globals.__ashInitialization = message.initialization;
		globals.__ashInvocation = (required = true): number | undefined => {
			if (required && (currentInvocation === undefined || !invocations.has(currentInvocation)))
				throw new Error('Browser invocation has retired');
			return currentInvocation;
		};
		globals.__ashRequest = (id: number, encoded: string): Promise<string> => {
			const invocation = invocations.get(id);
			if (!invocation || id !== currentInvocation) throw new Error('Browser invocation has retired');
			return clientRequest(JSON.parse(encoded), invocation.signal).then(value => JSON.stringify(value));
		};
		globals.__ashBackgroundRequest = (encoded: string): Promise<string> => {
			if (!runtime) throw new Error('Browser extension incarnation has retired');
			return clientRequest(JSON.parse(encoded)).then(value => JSON.stringify(value));
		};
		globals.__ashWebviewResource = (url: string): void => scope.postMessage({ type: 'webviewResource', url });
		globals.__ashRegistrationsChanged = (snapshot: JsonValue): void =>
			scope.postMessage({ type: 'registrationsChanged', snapshot });
		// Immutable bundled package code executes in a separate Worker realm.
		runtime = (await import(/* @vite-ignore */ message.entryPoint)) as BrowserRuntime;
		return runtime.activate();
	}
	if (message.type === 'deactivate') {
		for (const invocation of invocations.values()) invocation.abort();
		try {
			await runtime?.deactivate();
		} finally {
			runtime = undefined;
			for (const [id, command] of commands) {
				scope.postMessage({ type: 'clientCancel', id });
				command.reject(new Error('Browser extension has stopped'));
			}
			commands.clear();
			sentCommands = 0;
			invocations.clear();
		}
		return null;
	}
	if (!runtime) throw new Error('Browser extension is not active');
	const controller = new AbortController();
	invocations.set(message.id, controller);
	const previous = currentInvocation;
	currentInvocation = message.id;
	let result: Promise<JsonValue>;
	try {
		result = runtime.invoke(
			message.request.registrationId,
			message.request.payload,
			message.id,
			message.request.operation,
		);
	} finally {
		currentInvocation = previous;
	}
	try {
		return await result;
	} finally {
		invocations.delete(message.id);
	}
}

function clientRequest(request: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
	signal?.throwIfAborted();
	const id = nextCommand++;
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			const command = commands.get(id);
			if (!commands.delete(id)) return;
			if (command?.sent) {
				sentCommands--;
				scope.postMessage({ type: 'clientCancel', id });
			}
			reject(signal!.reason);
			pumpClientRequests();
		};
		signal?.addEventListener('abort', abort, { once: true });
		commands.set(id, {
			request,
			sent: false,
			resolve: value => {
				signal?.removeEventListener('abort', abort);
				resolve(value);
			},
			reject: error => {
				signal?.removeEventListener('abort', abort);
				reject(error);
			},
		});
		pumpClientRequests();
	});
}

function pumpClientRequests(): void {
	// Match the host's concurrency limit instead of terminating an extension on a large Explorer batch.
	for (const [id, command] of commands) {
		if (sentCommands >= 32) return;
		if (command.sent) continue;
		command.sent = true;
		sentCommands++;
		scope.postMessage({ type: 'clientRequest', id, request: command.request });
	}
}
