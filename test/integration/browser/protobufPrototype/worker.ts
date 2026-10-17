import { Emitter } from '../../../../src/ash/base/common/event.js';
import { WebWorkerServer } from '../../../../src/ash/base/common/worker/webWorker.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import type { AppServerDecodeContext } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolDecoding.js';
import { decodePrototypeInput } from './decode.js';

const scope = globalThis as unknown as { postMessage(value: unknown): void; addEventListener(type: 'message', callback: (event: MessageEvent) => void): void; };
const messages = new Emitter<unknown>();
scope.addEventListener('message', event => messages.fire(event.data));
const absoluteNow = (): number => performance.timeOrigin + performance.now();

new WebWorkerServer({
	onMessage: messages.event,
	send(message) {
		const value = message as { kind: string; requestId: number; result: object; };
		const start = performance.now();
		scope.postMessage(value.kind === 'result' ? { ...value, result: { ...value.result, returnStartedAt: absoluteNow() } } : value);
		const serializeMs = performance.now() - start;
		if (value.kind === 'result') scope.postMessage({ protocol: 'ash.codec.prototype.metrics', requestId: value.requestId, serializeMs });
	},
	dispose() { messages.dispose(); },
	[Symbol.dispose]() { messages.dispose(); },
}, { protocol: 'ash.codec.prototype', version: 1 }, {
	async handleRequest(job) {
		if (!['json', 'json-bytes', 'protobuf'].includes(job.codec as string)) throw new TypeError('Invalid prototype codec');
		if (typeof job.input !== 'string' && !(job.input instanceof ArrayBuffer)) throw new TypeError('Invalid prototype input');
		if ((typeof job.input === 'string' ? job.input.length * 2 : job.input.byteLength) > 320 * 1024 * 1024) throw new TypeError('Prototype input too large');
		const context = job.context as AppServerDecodeContext;
		if (!context || !Number.isSafeInteger(context.firstRequestId) || context.firstRequestId <= 0 || !Array.isArray(context.methods) || context.methods.length > 128) throw new TypeError('Invalid prototype routing context');
		for (const entry of context.methods) if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < context.firstRequestId || typeof entry[1] !== 'string' || !Object.hasOwn(APP_SERVER_METHODS, entry[1])) throw new TypeError('Invalid prototype method');
		return decodePrototypeInput(job.codec as string, job.input, context);
	},
	handleNotification() { throw new TypeError('Prototype Worker expects requests'); },
});
