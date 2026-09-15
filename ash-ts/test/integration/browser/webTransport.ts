import { AppServerWebSocketTransport } from '../../../src/ash/platform/app-server/browser/appServerWebSocketTransport.js';
import { WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT } from '../../../src/ash/platform/app-server/common/appServerTransport.js';

declare global {
	interface Window {
		ashWebTransportIntegration: {
			start(): void;
			send(frame: string): void;
			dispose(): void;
			messages: Array<{ event: string; payload: unknown }>;
		};
	}
}

let transport: AppServerWebSocketTransport | undefined;
const messages: Array<{ event: string; payload: unknown }> = [];
window.ashWebTransportIntegration = {
	start() {
		const url = new URL('/ash/app-server', location.href);
		url.protocol = 'ws:';
		transport = new AppServerWebSocketTransport(url);
		for (const event of [WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT]) {
			transport.on(event, payload => messages.push({ event, payload }));
		}
		transport.send(WEB_APP_SERVER_CONNECT_EVENT, { protocolVersion: 1 });
	},
	send(frame) { transport?.send(WEB_APP_SERVER_FRAME_EVENT, { frame }); },
	dispose() { transport?.dispose(); },
	messages,
};
