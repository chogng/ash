import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { MeteredConnectionCommand } from '../common/meteredConnectionIpc.js';
import type { MeteredConnectionMainService } from './meteredConnectionMainService.js';

/** Validates browser observations before changing the process-wide network policy. */
export class MeteredConnectionChannel implements IServerChannel {
	constructor(private readonly service: MeteredConnectionMainService) {}

	async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case MeteredConnectionCommand.SetIsBrowserConnectionMetered:
				if (typeof arg !== 'boolean') throw new TypeError('Metered connection observation must be boolean');
				this.service.setIsBrowserConnectionMetered(arg);
				return undefined as T;
			case MeteredConnectionCommand.IsConnectionMetered:
				if (arg !== undefined) throw new TypeError('Metered connection query takes no arguments');
				await this.service.whenConnectionStateInitialized;
				return this.service.isConnectionMetered as T;
			default:
				throw new Error(`Unknown metered connection command: ${command}`);
		}
	}

	listen<T>(_context: string, event: string, arg?: unknown): Event<T> {
		if (event !== MeteredConnectionCommand.OnDidChangeIsConnectionMetered)
			throw new Error(`Unknown metered connection event: ${event}`);
		if (arg !== undefined) throw new TypeError('Metered connection subscription takes no arguments');
		return this.service.onDidChangeIsConnectionMetered as Event<T>;
	}
}
