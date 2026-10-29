import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, type AppServerMethod } from '../../../../../.build/protocol/typescript/index.js';
import { decodeAppServerEnvelope, decodeAppServerNotification, decodeAppServerResponse, decodeAppServerServerRequest } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { isRecord } from '../../../base/common/types.js';
import type { WebWorkerRequestHandler } from '../../../base/common/worker/webWorker.js';

export const appServerDecodeChannel = { protocol: 'ash.appServer.decode', version: 1 };

/** Routing information captured at receipt, never a second request lifecycle owner. */
export interface AppServerDecodeContext {
	readonly firstRequestId: number;
	readonly canceledRequests?: readonly number[];
	readonly methods: readonly (readonly [number, AppServerMethod])[];
}

export type DecodedAppServerCall =
	| { readonly kind: 'notification'; readonly notification: ReturnType<typeof decodeAppServerNotification> }
	| { readonly kind: 'serverRequest'; readonly request: ReturnType<typeof decodeAppServerServerRequest> }
	| { readonly kind: 'unknownServerRequest'; readonly id: string | number };

export type DecodedAppServerFrame =
	| DecodedAppServerCall
	| {
			readonly kind: 'response';
			readonly method: AppServerMethod;
			readonly response: ReturnType<typeof decodeAppServerResponse>;
	  }
	| { readonly kind: 'retiredResponse'; readonly id: number };

/** Both paths share parsing and method-specific generated payload validation. */
export function decodeAppServerFrame(frame: string, context: AppServerDecodeContext): DecodedAppServerFrame {
	return decodeAppServerMessage(JSON.parse(frame), context);
}

/** Validate and route one decoded wire value; codecs do not own request state. */
export function decodeAppServerMessage(message: unknown, context: AppServerDecodeContext): DecodedAppServerFrame {
	const envelope = decodeAppServerEnvelope(message);
	if (envelope.kind === 'notification') return { kind: 'notification', notification: decodeAppServerNotification(message) };
	if (envelope.kind === 'serverRequest') {
		if (!Object.hasOwn(APP_SERVER_SERVER_REQUESTS, envelope.method)) return { kind: 'unknownServerRequest', id: envelope.id! };
		return { kind: 'serverRequest', request: decodeAppServerServerRequest(message) };
	}
	const id = envelope.id;
	if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('App Server emitted an invalid response ID');
	if (id < context.firstRequestId) return { kind: 'retiredResponse', id };
	const method = context.methods.find(entry => entry[0] === id)?.[1];
	if (!method) throw new Error('App Server emitted an unmatched response ID');
	// Canceled reads still consume their frame in order, but no consumer needs
	// a recursively validated graph or a large Worker reply anymore.
	if (context.canceledRequests?.includes(id)) return { kind: 'retiredResponse', id };
	return { kind: 'response', method, response: decodeAppServerResponse(method, message) };
}

export const appServerDecodeHandler: WebWorkerRequestHandler = {
	async handleRequest(message) {
		if (typeof message.frame !== 'string' || message.frame.length > 320 * 1024 * 1024 || !isRecord(message.context)) throw new TypeError('Invalid App Server decode request');
		const { firstRequestId, methods, canceledRequests } = message.context;
		if (!Number.isSafeInteger(firstRequestId) || (firstRequestId as number) <= 0 || !Array.isArray(methods) || methods.length > 128) throw new TypeError('Invalid App Server decode context');
		for (const entry of methods) {
			if (
				!Array.isArray(entry) ||
				entry.length !== 2 ||
				!Number.isSafeInteger(entry[0]) ||
				entry[0] < (firstRequestId as number) ||
				typeof entry[1] !== 'string' ||
				!Object.hasOwn(APP_SERVER_METHODS, entry[1])
			)
				throw new TypeError('Invalid App Server response method');
		}
		if (canceledRequests !== undefined && (!Array.isArray(canceledRequests) || canceledRequests.length > 128 || canceledRequests.some(id => !methods.some(entry => entry[0] === id))))
			throw new TypeError('Invalid canceled App Server request');
		return decodeAppServerFrame(message.frame, {
			firstRequestId: firstRequestId as number,
			methods: methods as [number, AppServerMethod][],
			canceledRequests: canceledRequests as number[] | undefined,
		});
	},
	handleNotification() {
		throw new TypeError('App Server decoder does not accept notifications');
	},
};

/** The private, application-owned Worker has already checked the payload schema.
 * Check its channel result's routing against this job, without recursively walking
 * the same graph again on the UI thread. Peer frames cannot enter this path.
 */
export function readDecodedAppServerFrame(value: unknown, context: AppServerDecodeContext): DecodedAppServerFrame {
	if (!isRecord(value)) throw new TypeError('Invalid App Server decoder result');
	if (value.kind === 'retiredResponse') {
		if (Number.isSafeInteger(value.id) && (value.id as number) > 0 && ((value.id as number) < context.firstRequestId || context.canceledRequests?.includes(value.id as number)))
			return value as DecodedAppServerFrame;
	} else if (value.kind === 'response') {
		const envelope = decodeAppServerEnvelope(value.response);
		if ((envelope.kind === 'response' || envelope.kind === 'error') && context.methods.some(entry => entry[0] === envelope.id && entry[1] === value.method)) return value as DecodedAppServerFrame;
	} else if (value.kind === 'notification') {
		if (decodeAppServerEnvelope(value.notification).kind === 'notification') return value as DecodedAppServerFrame;
	} else if (value.kind === 'serverRequest') {
		const envelope = decodeAppServerEnvelope(value.request);
		if (envelope.kind === 'serverRequest' && Object.hasOwn(APP_SERVER_SERVER_REQUESTS, envelope.method)) return value as DecodedAppServerFrame;
	} else if (value.kind === 'unknownServerRequest') {
		if (typeof value.id === 'string' || (typeof value.id === 'number' && Number.isSafeInteger(value.id))) return value as DecodedAppServerFrame;
	}
	throw new TypeError('Invalid App Server decoder result routing');
}
