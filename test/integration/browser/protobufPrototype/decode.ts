import { decodeAppServerMessage, type AppServerDecodeContext } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolDecoding.js';
import { normalizePrototype, parsePrototype } from './codecAdapter.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Shared by the threshold's synchronous path and its real Worker path. */
export function decodePrototypeInput(codec: string, input: string | ArrayBuffer, context: AppServerDecodeContext) {
	const workerReceivedAt = performance.timeOrigin + performance.now();
	const start = performance.now();
	const parsed: unknown = codec === 'protobuf' ? parsePrototype(new Uint8Array(input as ArrayBuffer)) : JSON.parse(codec === 'json-bytes' ? utf8.decode(input as ArrayBuffer) : input as string);
	const parsedAt = performance.now();
	const normalized = codec === 'protobuf' ? normalizePrototype(parsed) : parsed;
	const normalizedAt = performance.now();
	const decoded = decodeAppServerMessage(normalized, context);
	const validatedAt = performance.now();
	return { decoded, timing: { workerReceivedAt, parseMs: parsedAt - start, normalizeMs: normalizedAt - parsedAt, validateMs: validatedAt - normalizedAt } };
}
