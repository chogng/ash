import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IBrowserDownloadService } from '../common/browserDownloads.js';

export function browserDownloadsChannel(service: IBrowserDownloadService): IServerChannel<string> {
	return {
		listen: <T>(_context: string, event: string) => { if (event !== 'onDidChange') throw new Error('Unknown download event'); return service.onDidChange as import('../../../base/common/event.js').Event<T>; },
		call: async <T>(_context: string, command: string, args: unknown): Promise<T> => {
			if (!Array.isArray(args)) throw new TypeError('Invalid download arguments');
			if (command === 'getState' && args.length === 0) return await service.getState() as T;
			if (command === 'chooseDirectory' && args.length === 0) return await service.chooseDirectory() as T;
			if (command === 'configure' && args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'boolean') return await service.configure(args[0], args[1]) as T;
			if (command === 'perform' && args.length === 2 && typeof args[0] === 'string' && /^[a-f0-9-]{36}$/u.test(args[0]) && ['open', 'show', 'deleteFile', 'remove'].includes(args[1])) return await service.perform(args[0], args[1]) as T;
			throw new TypeError('Invalid download operation');
		},
	};
}
