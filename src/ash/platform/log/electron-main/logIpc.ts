import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { validateLogEntry } from '../common/logIpc.js';
import type { LoggerService } from '../node/loggerService.js';

export class LoggerChannel implements IServerChannel {
	constructor(private readonly loggerService: LoggerService) { }

	public async call<T>(context: string, command: string, arg: unknown): Promise<T> {
		if (!/^window:[1-9]\d*$/.test(context)) { throw new TypeError('Invalid logger window'); }
		if (command === 'log') {
			await this.loggerService.log(context.replace(':', '-'), validateLogEntry(arg));
			return undefined as T;
		}
		if (command === 'flush' && arg === undefined) {
			await this.loggerService.flush();
			return undefined as T;
		}
		throw new Error(`Unknown logger command: ${command}`);
	}

	public listen<T>(_context: string, event: string): Event<T> {
		throw new Error(`Unknown logger event: ${event}`);
	}
}
