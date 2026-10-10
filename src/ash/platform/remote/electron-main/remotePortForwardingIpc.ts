import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { boundedPositiveInteger, nonEmptyString, record } from '../../ipc/electron-main/ipcValidation.js';
import type { SshPortForwardingService } from './sshPortForwardingService.js';

/** Main's authenticated renderer context selects the window's sole SSH owner. */
export function remotePortForwardingChannel(getService: (context: string) => SshPortForwardingService): IServerChannel<string> {
	return {
		call: async <T>(context: string, command: string, value?: unknown): Promise<T> => {
			const service = getService(context);
			switch (command) {
				case 'ash:remote:tunnel:list':
					emptyParams(value);
					return await service.list() as T;
				case 'ash:remote:tunnel:open': {
					const params = record(value, ['remotePort']);
					return await service.open({ remotePort: boundedPositiveInteger(params.remotePort, 'remotePort', 65535) }) as T;
				}
				case 'ash:remote:tunnel:close': {
					const params = record(value, ['id']);
					await service.close(nonEmptyString(params.id, 'id'));
					return undefined as T;
				}
				default:
					throw new Error('Unknown Remote port-forwarding operation');
			}
		},
		listen: <T>(context: string, event: string, value?: unknown): Event<T> => {
			emptyParams(value);
			if (event !== 'ash:remote:tunnel:changed') {
				throw new Error('Unknown Remote port-forwarding event');
			}
			const service = getService(context);
			return service.onDidChange.bind(service) as Event<T>;
		},
	};
}

function emptyParams(value: unknown): void {
	if (value !== undefined) {
		throw new Error('Remote tunnel operation does not accept parameters');
	}
}
