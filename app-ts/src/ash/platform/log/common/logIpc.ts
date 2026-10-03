import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { isRecord } from '../../../base/common/types.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { ConsoleLogSink } from './consoleLogSink.js';
import { isLogLevel, LogLevel, type ILoggerService, type ILogSink, type LogEntry } from './log.js';
import { LogService } from './logServiceImpl.js';

/** The authenticated channel supplies the source window; entries cannot choose files. */
export class LoggerChannelClient implements ILoggerService, ILogSink {
	private readonly channel: IChannel;
	private writes: Promise<void> = Promise.resolve();

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.channel = mainProcessService.getChannel('logger');
	}

	public createLogger(category: string): LogService {
		if (!category.trim()) { throw new TypeError('Invalid logger category'); }
		return new LogService({ sinks: [new ConsoleLogSink(), {
			log: entry => this.log({ ...entry, category: entry.category === 'application' ? category : entry.category }),
		}] });
	}

	public log(entry: LogEntry): void {
		const error = entry.error instanceof Error ? entry.error.stack ?? entry.error.message : entry.error === undefined ? undefined : String(entry.error);
		const serialized = { ...entry, error };
		this.writes = Promise.all([this.writes, this.channel.call<void>('log', serialized)]).then(() => undefined);
		// Reporting through ILogService here would send the failed write back to this channel.
		void this.writes.catch(failure => console.error('Failed to persist Desktop log', failure));
	}

	public async flush(): Promise<void> {
		await this.writes;
		await this.channel.call('flush');
	}
}

export function validateLogEntry(value: unknown): LogEntry {
	if (!isRecord(value) || typeof value.timestampMillis !== 'number' || !Number.isFinite(value.timestampMillis) || value.timestampMillis < 0
		|| !isLogLevel(value.level) || value.level === LogLevel.Off
		|| typeof value.category !== 'string' || !value.category.trim()
		|| typeof value.message !== 'string' || !value.message.trim()
		|| (value.error !== undefined && typeof value.error !== 'string')) {
		throw new TypeError('Invalid log entry');
	}
	return { timestampMillis: value.timestampMillis, level: value.level, category: value.category, message: value.message, error: value.error };
}
