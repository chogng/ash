export const WEB_APP_SERVER_PROTOCOL_VERSION = 1;
export const WEB_APP_SERVER_CONNECT_EVENT = "ash:app-server:connect";
export const WEB_APP_SERVER_CONNECTED_EVENT = "ash:app-server:connected";
export const WEB_APP_SERVER_DISCONNECT_EVENT = "ash:app-server:disconnect";
export const WEB_APP_SERVER_FRAME_EVENT = "ash:app-server:frame";
export const WEB_APP_SERVER_CLOSED_EVENT = "ash:app-server:closed";

/** Carries one renderer's frames and may deliver events synchronously.
 * Disconnect releases this lease; intentional closure means a local stop or
 * terminal authorization failure, while remote interruption remains recoverable.
 */
export interface AppServerTransport {
	on(event: string, listener: (payload: unknown) => void): void;
	off(event: string, listener: (payload: unknown) => void): void;
	send(event: string, payload?: unknown): void;
}
