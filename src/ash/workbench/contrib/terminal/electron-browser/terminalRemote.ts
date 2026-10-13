import { registerTerminalBackend } from '../browser/agentHostTerminalService.js';
import { RemoteTerminalBackend } from '../browser/remoteTerminalBackend.js';

/** Desktop SSH windows use the same approved process adapter and a host-pinned backend. */
export function registerRemoteContributions(): void {
	registerTerminalBackend('remote', RemoteTerminalBackend);
}
