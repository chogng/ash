import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { isRecord } from '../../../base/common/types.js';
import { ConsoleLogSink } from './consoleLogSink.js';
import {
	isLogLevel,
	LogLevel,
	AbstractLoggerService,
	type ILogSink,
	type LogEntry,
	type ILogFileService,
	type ILogFile,
	type ILogFileReadResult,
} from './log.js';
import { LogService } from './logServiceImpl.js';
import { localize } from '../../../nls.js';

const MaxPendingEntries = 128;
const MaxPendingCharacters = 256 * 1024;

/** The authenticated channel supplies the source window; entries cannot choose files. */
export class LoggerChannelClient extends AbstractLoggerService<LogService> implements ILogSink {
	private writes: Promise<void> = Promise.resolve();
	private pendingEntries = 0;
	private pendingCharacters = 0;
	private omittedEntries = 0;
	private omissionScheduled = false;
	private failure: { error: unknown } | undefined;
	readonly files: ILogFileService;

	constructor(private readonly channel: IChannel) {
		super();
		this.files = {
			list: async () => {
				await this.whenWritten();
				const value = await this.channel.call<unknown>('list');
				if (
					!Array.isArray(value) ||
					value.some(
						file =>
							!isRecord(file) ||
							typeof file.id !== 'string' ||
							typeof file.source !== 'string' ||
							(file.format !== 'text' && file.format !== 'jsonl') ||
							typeof file.live !== 'boolean' ||
							typeof file.currentWindow !== 'boolean',
					)
				) {
					throw new TypeError('Invalid log file catalog');
				}
				return value as ILogFile[];
			},
			read: async (id, cursor) => {
				await this.whenWritten();
				const value = await this.channel.call<unknown>('read', { id, cursor });
				if (
					!isRecord(value) ||
					typeof value.text !== 'string' ||
					value.text.length > 1024 * 1024 ||
					typeof value.gap !== 'boolean' ||
					!isRecord(value.cursor) ||
					typeof value.cursor.generation !== 'string' ||
					!Number.isSafeInteger(value.cursor.offset) ||
					(value.cursor.offset as number) < 0
				) {
					throw new TypeError('Invalid log file content');
				}
				return value as unknown as ILogFileReadResult;
			},
		};
	}

	protected doCreateLogger(category: string): LogService {
		if (!category.trim()) {
			throw new TypeError('Invalid logger category');
		}
		return new LogService({
			flush: () => this.flush(),
			sinks: [
				new ConsoleLogSink(),
				{
					log: entry =>
						this.log({ ...entry, category: entry.category === 'application' ? category : entry.category }),
				},
			],
		});
	}

	public log(entry: LogEntry): void {
		if (this.isDisposed) {
			return;
		}
		const error =
			entry.error instanceof Error
				? (entry.error.stack ?? entry.error.message)
				: entry.error === undefined
					? undefined
					: String(entry.error);
		const serialized = { ...entry, error };
		const characters = entry.category.length + entry.message.length + (error?.length ?? 0);
		// Disk rotation bounds saved files, not queued IPC payloads. Keep one request
		// in flight and a bounded text backlog when the Main writer falls behind.
		if (this.pendingEntries >= MaxPendingEntries || this.pendingCharacters + characters > MaxPendingCharacters) {
			this.omittedEntries++;
			if (!this.omissionScheduled) {
				this.omissionScheduled = true;
				this.writes = this.writes.then(async () => {
					const omitted = this.omittedEntries;
					this.omittedEntries = 0;
					this.omissionScheduled = false;
					await this.write({
						timestampMillis: Date.now(),
						category: 'logs',
						level: LogLevel.Warning,
						message: localize(
							'logs.pendingLimit',
							'Omitted {0} log entries because the pending log limit was exceeded.',
							omitted,
						),
						error: undefined,
					});
				});
			}
			return;
		}
		this.pendingEntries++;
		this.pendingCharacters += characters;
		this.writes = this.writes.then(async () => {
			try {
				await this.write(serialized);
			} finally {
				this.pendingEntries--;
				this.pendingCharacters -= characters;
			}
		});
	}

	private async write(entry: LogEntry): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		try {
			await this.channel.call<void>('log', entry);
		} catch (error) {
			if (this.failure) {
				return;
			}
			this.failure = { error };
			// Neither this logger nor a failing console may create another logging request.
			try {
				console.error('Failed to persist Desktop log', error);
			} catch {
				/* The original transport failure remains available through flush. */
			}
		}
	}

	private async whenWritten(): Promise<void> {
		await this.writes;
		if (this.failure) {
			throw this.failure.error;
		}
	}

	public async flush(): Promise<void> {
		await this.whenWritten();
		await this.channel.call('flush');
	}
}

export function validateLogEntry(value: unknown): LogEntry {
	if (
		!isRecord(value) ||
		typeof value.timestampMillis !== 'number' ||
		!Number.isFinite(value.timestampMillis) ||
		value.timestampMillis < 0 ||
		!isLogLevel(value.level) ||
		value.level === LogLevel.Off ||
		typeof value.category !== 'string' ||
		!value.category.trim() ||
		typeof value.message !== 'string' ||
		!value.message.trim() ||
		(value.error !== undefined && typeof value.error !== 'string')
	) {
		throw new TypeError('Invalid log entry');
	}
	return {
		timestampMillis: value.timestampMillis,
		level: value.level,
		category: value.category,
		message: value.message,
		error: value.error,
	};
}
