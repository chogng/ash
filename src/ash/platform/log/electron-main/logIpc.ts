import { DEFAULT_LOG_LEVEL, type LogLevel } from '../common/log.js';
import type { Event } from '../../../base/common/event.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { validateLogEntry } from '../common/logIpc.js';
import { isRecord } from '../../../base/common/types.js';
import type { LoggerService } from '../node/loggerService.js';

export class LoggerChannel implements IServerChannel {
	constructor(
		private readonly loggerService: LoggerService,
		private readonly startupLevels: {
			logLevel?: string;
			extensionLogLevel: [string, string][];
			initialLogLevel: LogLevel;
		} = { extensionLogLevel: [], initialLogLevel: DEFAULT_LOG_LEVEL },
	) {}

	public async call<T>(context: string, command: string, arg: unknown): Promise<T> {
		if (!/^window:[1-9]\d*$/.test(context)) {
			throw new TypeError('Invalid logger window');
		}
		if (command === 'getDefaultLogLevels' && arg === undefined) return this.startupLevels as T;
		if (command === 'log') {
			await this.loggerService.log(context.replace(':', '-'), validateLogEntry(arg));
			return undefined as T;
		}
		if (command === 'flush' && arg === undefined) {
			await this.loggerService.flush();
			return undefined as T;
		}
		if (command === 'list' && arg === undefined) {
			return (await this.loggerService.getLogFiles(context.replace(':', '-'))) as T;
		}
		if (command === 'read' && isRecord(arg) && typeof arg.id === 'string' && arg.id.length <= 512) {
			const cursor = arg.cursor;
			if (
				cursor !== undefined &&
				(!isRecord(cursor) || typeof cursor.generation !== 'string' || cursor.generation.length > 128 || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0)
			) {
				throw new TypeError('Invalid log cursor');
			}
			return (await this.loggerService.readLogFile(arg.id, cursor as { generation: string; offset: number } | undefined)) as T;
		}
		throw new Error(`Unknown logger command: ${command}`);
	}

	public listen<T>(_context: string, event: string): Event<T> {
		throw new Error(`Unknown logger event: ${event}`);
	}
}
