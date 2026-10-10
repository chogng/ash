// Product Node entry point. Rust owns consent, process-tree supervision and wire validation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createConnection } from 'node:net';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __runtime as runtime } from './sdk.mjs';

const maximumFrame = 1024 * 1024;
const maximumPayload = 512 * 1024;
const calls = new Map();
const retiredCalls = new Map();
const active = new Map();
const seen = new Set();
const invocation = new AsyncLocalStorage();
let nextCall = 0;
let sentCalls = 0;
let identity;
let phase = 'new';
let bridge;
let extension;
let stopping;
const args = process.argv.slice(2);
if (args.length !== 12 || args[0] !== '--extension-id' || args[2] !== '--package'
	|| args[4] !== '--entry' || args[6] !== '--api' || args[7] !== 'vscode'
	|| args[8] !== '--protocol-address' || args[10] !== '--protocol-token') {
	throw new Error('Invalid Node extension host binding');
}
const address = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(args[9]);
if (!address || Number(address[1]) > 65535 || !/^[a-f0-9]{64}$/.test(args[11])) throw new Error('Invalid Node control binding');
const control = createConnection({ host: '127.0.0.1', port: Number(address[1]) });
control.on('error', error => { process.stderr.write(String(error) + '\n'); process.exit(1); });
await new Promise(resolveConnected => control.once('connect', resolveConnected));
control.setNoDelay(true);
await new Promise((resolveWrite, reject) => control.write(args[11] + '\n', error => error ? reject(error) : resolveWrite()));
const protocolWrite = control.write.bind(control);
const extensionId = args[1];
const root = realpathSync(args[3]);
const entry = realpathSync(resolve(root, args[5]));
const entryRelative = relative(root, entry);
if (!isAbsolute(args[3]) || isAbsolute(args[5]) || entryRelative.startsWith(`..${sep}`)
	|| entryRelative === '..' || isAbsolute(entryRelative) || !statSync(entry).isFile()) {
	throw new Error('Extension entry escapes its admitted package');
}
const manifestBytes = readFileSync(resolve(root, 'package.json'));
if (manifestBytes.length > 4 * 1024 * 1024) throw new Error('Extension manifest quota exceeded');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') throw new Error('Invalid extension manifest');

function loadLocalization(language) {
	if (language === 'en' || typeof manifest.l10n !== 'string' || !manifest.l10n) return undefined;
	if (typeof language !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(language)) throw new Error('Invalid window language');
	try {
		const path = realpathSync(resolve(root, manifest.l10n, `bundle.l10n.${language.toLowerCase()}.json`));
		const packagePath = relative(root, path);
		if (packagePath === '..' || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath)) throw new Error('Localization bundle escapes its admitted package');
		if (!statSync(path).isFile() || statSync(path).size > maximumPayload) throw new Error('Localization bundle quota exceeded');
		const bundle = JSON.parse(readFileSync(path, 'utf8'));
		if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || Object.values(bundle).some(value => typeof value !== 'string')) throw new Error('Invalid localization bundle');
		return { bundle: Object.freeze(bundle), uri: pathToFileURL(path).href };
	} catch (error) {
		if (error.code !== 'ENOENT') process.stderr.write(`Extension localization: ${error.message}\n`);
		return undefined;
	}
}

function applyEnvironment(environment) {
	if (environment === undefined || environment === null) return;
	if (typeof environment !== 'object' || Array.isArray(environment)) throw new Error('Invalid extension environment');
	const entries = Object.entries(environment);
	if (entries.length > 128 || entries.some(([key, value]) => key.length > 128 || !/^[a-z_][a-z0-9_]*$/i.test(key)
		|| value !== null && (typeof value !== 'string' || value.length > 8192 || value.includes('\0')))) {
		throw new Error('Invalid extension environment');
	}
	// Validate the whole handshake before changing this incarnation's process state.
	// Delivery follows executable selection, so overrides cannot alter the Node launcher.
	for (const [key, value] of entries) {
		if (value === null) delete process.env[key];
		else process.env[key] = value;
	}
}

// Debug children can inherit ordinary stdio; only the private socket carries Host RPC.
// This is a transport rule, not a sandbox: authorized Node extensions have user-level IO.
// Extension errors are recorded without killing unrelated registrations or interrupting shutdown.
// Malformed control frames still terminate the process in the transport reader below.
function reportExtensionError(error) {
	if (error?.code === 'cancelled') return;
	process.stderr.write(String(error?.stack ?? error) + '\n');
}
process.on('unhandledRejection', reportExtensionError);
process.on('uncaughtException', reportExtensionError);
function send(frame) {
	const bytes = JSON.stringify(frame);
	if (Buffer.byteLength(bytes) > maximumFrame) throw new Error('Host frame quota exceeded');
	return new Promise((resolveWrite, reject) => protocolWrite(bytes + '\n', error => error ? reject(error) : resolveWrite()));
}
function context(frame) {
	return {
		protocolVersion: frame.protocolVersion, requestId: frame.requestId,
		incarnation: frame.incarnation, activationGeneration: frame.activationGeneration
	};
}
function same(left, right) {
	return left && right && Object.keys(left).every(key => left[key] === right[key]);
}
function failCalls(requestId, message) {
	for (const [id, call] of calls) {
		if (call.context.requestId !== requestId) continue;
		calls.delete(id);
		if (call.sent) sentCalls--;
		if (call.sent) retiredCalls.set(id, call.context);
		if (retiredCalls.size > 4096) retiredCalls.delete(retiredCalls.keys().next().value);
		call.reject(Object.assign(new Error(message), { code: 'cancelled' }));
	}
	pumpClientCalls();
}
Object.defineProperty(globalThis, '__ashInvocation', {
	value(required = true) {
		const current = invocation.getStore();
		if (current && active.get(current.requestId)?.context === current) return current.requestId;
		if (required) throw new Error('No active extension invocation');
		return undefined;
	}
});
Object.defineProperty(globalThis, '__ashRequest', {
	value(requestId, encoded) {
		const current = invocation.getStore();
		const owned = active.get(requestId);
		if (!current || current.requestId !== requestId || owned?.context !== current || owned.cancelled) {
			throw new Error('Extension service call belongs to an expired invocation');
		}
		return clientRequest(current, encoded);
	}
});

function clientRequest(callContext, encoded) {
	if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maximumPayload || calls.size >= 128) {
		throw new Error('Extension client request quota exceeded');
	}
	const operation = JSON.parse(encoded);
	if (typeof operation.operation !== 'string') throw new Error('Invalid extension client operation');
	const callId = ++nextCall;
	if (!Number.isSafeInteger(callId)) throw new Error('Client call identity exhausted');
	return new Promise((resolveCall, reject) => {
		calls.set(callId, { context: callContext, operation, sent: false, resolve: resolveCall, reject });
		pumpClientCalls();
	});
}
function pumpClientCalls() {
	if (!['activating', 'active'].includes(phase)) return;
	// Backpressure matches the shared process limit; queued calls retain the same fence.
	for (const [callId, call] of calls) {
		if (sentCalls >= 32) break;
		if (call.sent) continue;
		call.sent = true;
		sentCalls++;
		void send({ context: call.context, callId, operation: call.operation }).catch(error => {
			if (!calls.delete(callId)) return;
			sentCalls--;
			call.reject(error);
			pumpClientCalls();
		});
	}
}
Object.defineProperty(globalThis, '__ashBackgroundRequest', {
	value(encoded) {
		if (!['activating', 'active'].includes(phase) || !identity) throw new Error('Extension activation is no longer active');
		return clientRequest({ protocolVersion: 1, ...identity }, encoded);
	}
});

// Synchronous public hooks preserve Node's CJS/ESM resolution and cache. Only the
// editor API and its product SDK are substituted; builtins and package modules stay Node-owned.
const facadeURL = new URL('./vscode.mjs', import.meta.url).href;
const sdkURL = new URL('./sdk.mjs', import.meta.url).href;
let apiSource;
const hooks = registerHooks({
	resolve(specifier, ctx, next) {
		if (specifier === '@ash/extension' && ctx.parentURL === facadeURL) return { url: sdkURL, shortCircuit: true };
		if (specifier === 'vscode') {
			if (!apiSource) throw new Error('Editor API is not initialized');
			return { url: 'ash:vscode', shortCircuit: true };
		}
		return next(specifier, ctx);
	},
	load(url, ctx, next) {
		if (url === 'ash:vscode') return { format: 'module', source: apiSource, shortCircuit: true };
		return next(url, ctx);
	},
});
const { createApi } = await import(facadeURL);
async function dispatch(frame) {
	const ctx = context(frame);
	let success;
	try {
		switch (frame.method) {
			case 'initialize':
				if (phase !== 'new' || frame.params?.extensionId !== extensionId || frame.params?.runtimeApiVersion !== 1) throw new Error('Invalid initialization');
				applyEnvironment(frame.params.environment);
				identity = { incarnation: ctx.incarnation, activationGeneration: ctx.activationGeneration };
				phase = 'initialized';
				success = { result: 'initialized', body: { protocolVersion: 1, runtimeApiVersion: 1 } };
				break;
			case 'activate': {
				if (phase !== 'initialized' || frame.params?.extensionId !== extensionId || !frame.params.initialization) throw new Error('Invalid activation');
				phase = 'activating';
				const publicContext = runtime.beginActivation(extensionId);
				bridge = createApi({
					commands: manifest.contributes?.commands ?? [], debuggers: manifest.contributes?.debuggers ?? [],
					extensionId: `${manifest.publisher}.${manifest.name}`, extensionPath: root, pathSeparator: sep, manifest,
					localization: loadLocalization(frame.params.initialization.language ?? 'en'),
				}, frame.params.initialization);
				Object.defineProperty(globalThis, '__ashVscodeApi', { value: bridge.api });
				apiSource = `const api = globalThis.__ashVscodeApi; export default api; export {api as 'module.exports'};\n`
					+ Object.keys(bridge.api).map(key => `export const ${key} = api[${JSON.stringify(key)}];`).join('\n');
				extension = await import(pathToFileURL(entry).href);
				const implementation = extension.default ?? extension;
				if (typeof implementation.activate !== 'function') throw new Error('Extension has no activate function');
				await bridge.activate(publicContext, implementation.activate, implementation, frame.params.capabilities);
				const registrations = JSON.parse(runtime.sealActivation());
				phase = 'active';
				success = { result: 'activated', body: { registrations } };
				break;
			}
			case 'invoke': {
				if (phase !== 'active' || frame.params?.extensionId !== extensionId) throw new Error('Extension is not active');
				if (!Number.isSafeInteger(frame.params.deadlineUnixMillis) || frame.params.deadlineUnixMillis <= Date.now()) {
					throw Object.assign(new Error('Invocation deadline expired'), { code: 'deadlineExceeded' });
				}
				const owned = { context: ctx, cancelled: false };
				active.set(ctx.requestId, owned);
				try {
					const payload = await invocation.run(ctx, () => runtime.invoke(frame.params.registrationId,
						JSON.stringify(frame.params.payload), ctx.requestId, frame.params.operation));
					success = { result: 'invoked', body: { payload: JSON.parse(payload) } };
				} finally {
					active.delete(ctx.requestId);
					failCalls(ctx.requestId, 'Invocation has returned');
				}
				break;
			}
			case 'cancel': {
				const id = frame.params?.requestId;
				const owned = active.get(id);
				if (owned) owned.cancelled = true;
				failCalls(id, 'Invocation was cancelled');
				runtime.cancel(id);
				success = { result: 'cancelled' };
				break;
			}
			case 'ping': success = { result: 'pong' }; break;
			case 'deactivate':
			case 'shutdown':
				if (!stopping) stopping = (async () => {
					phase = 'stopping';
					failCalls(undefined, 'Extension is stopping');
					for (const [id, owned] of active) { owned.cancelled = true; runtime.cancel(id); failCalls(id, 'Extension is stopping'); }
					bridge?.deactivate();
					const implementation = extension?.default ?? extension;
					await runtime.deactivate(() => implementation?.deactivate?.());
					hooks.deregister();
					phase = 'disposed';
				})();
				await stopping;
				success = { result: frame.method === 'shutdown' ? 'shutdown' : 'deactivated' };
				break;
			default: throw new Error('Unsupported host method');
		}
		await send({ ...ctx, status: 'success', body: success });
		if (frame.method === 'shutdown') process.exit(0);
	} catch (error) {
		// Details stay on captured stderr; only a bounded failure crosses the public protocol.
		process.stderr.write(String(error?.stack ?? error) + '\n');
		await send({ ...ctx, status: 'failure', body: { code: error?.code === 'deadlineExceeded' ? 'deadlineExceeded' : frame.method === 'activate' ? 'activationFailed' : 'internal', message: 'Extension host operation failed' } });
	}
}
function receive(frame) {
	if (frame.context && frame.callId !== undefined) {
		const call = calls.get(frame.callId);
		if (!call && same(retiredCalls.get(frame.callId), frame.context)) {
			retiredCalls.delete(frame.callId);
			return; // Revocation already rejected this call; its late reply has no authority.
		}
		if (!call || !same(call.context, frame.context)) throw new Error('Unknown extension client response');
		calls.delete(frame.callId);
		if (!call.sent) throw new Error('Response preceded client request');
		sentCalls--;
		pumpClientCalls();
		if (frame.outcome?.Ok) call.resolve(JSON.stringify(frame.outcome.Ok));
		else if (frame.outcome?.Err) call.reject(Object.assign(new Error(frame.outcome.Err.message), { code: frame.outcome.Err.code }));
		else throw new Error('Invalid extension client response');
		return;
	}
	const ctx = context(frame);
	if (ctx.protocolVersion !== 1 || ![ctx.requestId, ctx.incarnation, ctx.activationGeneration].every(value => Number.isSafeInteger(value) && value > 0)
		|| seen.has(ctx.requestId) || seen.size >= 1000000 || (identity && (ctx.incarnation !== identity.incarnation || ctx.activationGeneration !== identity.activationGeneration))) {
		throw new Error('Invalid extension request identity');
	}
	seen.add(ctx.requestId);
	void dispatch(frame);
}
let buffered = Buffer.alloc(0);
control.on('data', bytes => {
	try {
		buffered = Buffer.concat([buffered, bytes]);
		let end;
		while ((end = buffered.indexOf(10)) !== -1) {
			if (end > maximumFrame) throw new Error('Host input frame quota exceeded');
			const line = buffered.subarray(0, end);
			buffered = buffered.subarray(end + 1);
			receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
		}
		if (buffered.length > maximumFrame) throw new Error('Host input frame quota exceeded');
	} catch (error) {
		process.stderr.write(String(error) + '\n');
		process.exit(1);
	}
});
// Parent transport closure revokes the incarnation, including extensions retaining timers.
control.on('end', () => process.exit(0));
control.on('close', () => process.exit(0));
