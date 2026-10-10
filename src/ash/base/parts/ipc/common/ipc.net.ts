import type { VSBuffer } from '../../../common/buffer.js';
import type { IDisposable } from '../../../common/lifecycle.js';

export const enum SocketDiagnosticsEventType {
	Created = 'created',
	Read = 'read',
	Write = 'write',
	Open = 'open',
	Error = 'error',
	Close = 'close',
	BrowserWebSocketBlobReceived = 'browserWebSocketBlobReceived',
	NodeEndReceived = 'nodeEndReceived',
	NodeEndSent = 'nodeEndSent',
	NodeDrainBegin = 'nodeDrainBegin',
	NodeDrainEnd = 'nodeDrainEnd',
	zlibInflateError = 'zlibInflateError',
	zlibInflateData = 'zlibInflateData',
	zlibInflateInitialWrite = 'zlibInflateInitialWrite',
	zlibInflateInitialFlushFired = 'zlibInflateInitialFlushFired',
	zlibInflateWrite = 'zlibInflateWrite',
	zlibInflateFlushFired = 'zlibInflateFlushFired',
	zlibDeflateError = 'zlibDeflateError',
	zlibDeflateData = 'zlibDeflateData',
	zlibDeflateWrite = 'zlibDeflateWrite',
	zlibDeflateFlushFired = 'zlibDeflateFlushFired',
	WebSocketNodeSocketWrite = 'webSocketNodeSocketWrite',
	WebSocketNodeSocketPeekedHeader = 'webSocketNodeSocketPeekedHeader',
	WebSocketNodeSocketReadHeader = 'webSocketNodeSocketReadHeader',
	WebSocketNodeSocketReadData = 'webSocketNodeSocketReadData',
	WebSocketNodeSocketUnmaskedData = 'webSocketNodeSocketUnmaskedData',
	WebSocketNodeSocketDrainBegin = 'webSocketNodeSocketDrainBegin',
	WebSocketNodeSocketDrainEnd = 'webSocketNodeSocketDrainEnd',
	ProtocolHeaderRead = 'protocolHeaderRead',
	ProtocolMessageRead = 'protocolMessageRead',
	ProtocolHeaderWrite = 'protocolHeaderWrite',
	ProtocolMessageWrite = 'protocolMessageWrite',
	ProtocolWrite = 'protocolWrite',
}

export const enum SocketCloseEventType {
	NodeSocketCloseEvent,
	WebSocketCloseEvent,
}
export interface NodeSocketCloseEvent {
	readonly type: SocketCloseEventType.NodeSocketCloseEvent;
	readonly hadError: boolean;
	readonly error: Error | undefined;
}
export interface WebSocketCloseEvent {
	readonly type: SocketCloseEventType.WebSocketCloseEvent;
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
	readonly event: unknown | undefined;
}
export type SocketCloseEvent = NodeSocketCloseEvent | WebSocketCloseEvent | undefined;

/** A byte connection. drain waits for accepted writes; disposal closes the connection. */
export interface ISocket extends IDisposable {
	onData(listener: (data: VSBuffer) => void): IDisposable;
	onClose(listener: (event: SocketCloseEvent) => void): IDisposable;
	onEnd(listener: () => void): IDisposable;
	write(buffer: VSBuffer): void;
	end(): void;
	drain(): Promise<void>;
	traceSocketEvent(type: SocketDiagnosticsEventType, data?: unknown): void;
}
