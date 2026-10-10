import { decodeRemoteTunnelHostInfo } from '../../../../../.build/protocol/typescript/WebProtocolDecoder.js';

export const TUNNEL_MACHINE_STATUS_PREFIX = '__ASH_TUNNEL_STATUS__';
export type TunnelMachineStatus = {
	readonly type: 'connected';
	readonly tunnelName: string;
	readonly tunnelId?: string;
	readonly isAttached: boolean;
	readonly link?: string;
	readonly domain?: string;
} | { readonly type: 'tokenError'; readonly message: string; };

/** Converts the helper's generated launch contract to the frontend tunnel domain. */
export function parseTunnelMachineStatus(message: string): TunnelMachineStatus | undefined {
	if (!message.startsWith(TUNNEL_MACHINE_STATUS_PREFIX)) {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(message.slice(TUNNEL_MACHINE_STATUS_PREFIX.length));
		const info = decodeRemoteTunnelHostInfo(value);
		const link = new URL('browser/workbench/workbench.html', info.web.endpoint);
		link.hash = `ash-endpoint=${encodeURIComponent(info.web.endpoint)}&ash-ticket=${encodeURIComponent(info.web.ticket)}`;
		return {
			type: 'connected',
			tunnelName: info.relayHost,
			tunnelId: String(info.relayPort),
			isAttached: false,
			link: link.toString(),
			domain: info.relayHost,
		};
	} catch {
		return undefined;
	}
}
