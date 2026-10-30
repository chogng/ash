import type { VSBuffer } from '../../../base/common/buffer.js';

// A local carrier installs and verifies the bundled backend on first use before
// it can forward initialize. Main and Renderer must allow that same cold start.
export const LOCAL_APP_SERVER_INITIALIZE_TIMEOUT_MS = 90_000;

/** A Main-owned carrier lease, distinct from workspace and backend Session identities. */
export type AppServerConnectionTarget = 'workspace' | 'local' | { readonly id: string; };

export function appServerConnectionChannel(target: AppServerConnectionTarget): string {
	return typeof target === 'object' ? `ash:app-server:host:${target.id}`
		: target === 'local' ? 'ash:app-server:local' : 'ash:app-server';
}

export const WEB_APP_SERVER_PROTOCOL_VERSION = 1;
export const WEB_APP_SERVER_CONNECT_EVENT = 'ash:app-server:connect';
export const WEB_APP_SERVER_CONNECTED_EVENT = 'ash:app-server:connected';
export const WEB_APP_SERVER_DISCONNECT_EVENT = 'ash:app-server:disconnect';
export const WEB_APP_SERVER_FRAME_EVENT = 'ash:app-server:frame';
export const WEB_APP_SERVER_CLOSED_EVENT = 'ash:app-server:closed';

/** An in-process frame whose UTF-8 byte length was checked by its transport.
 * Construct this only after validating received bytes, never from peer-supplied
 * length metadata. It lets the protocol client reuse that boundary's check.
 */
export class AppServerFrame {
	/** Set synchronously when consumption continues in a Worker. Completion always
	 * resolves, including connection retirement; protocol failures travel via close.
	 */
	public consumed: Promise<void> | undefined;
	constructor(readonly frame: string, readonly byteLength: number) { }
}

// Keep read credit local to this carrier, without changing ISocket or retaining
// received buffers after their consumer and ACK callback release them.
const readConsumption = new WeakMap<VSBuffer, Promise<void>>();
export function deferAppServerRead(buffer: VSBuffer, consumed: Promise<void>): void { readConsumption.set(buffer, consumed); }
export function getAppServerReadConsumption(buffer: VSBuffer): Promise<void> | undefined { return readConsumption.get(buffer); }

/** Carries one renderer's frames and may deliver events synchronously.
 * Disconnect releases this lease; intentional closure means a local stop or
 * terminal authorization failure, while remote interruption remains recoverable.
 */
export interface AppServerTransport {
	on(event: string, listener: (payload: unknown) => void): void;
	off(event: string, listener: (payload: unknown) => void): void;
	send(event: string, payload?: unknown): void;
}
