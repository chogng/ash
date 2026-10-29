import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import {
	AbstractLoggerService,
	canLog,
	DEFAULT_LOG_LEVEL,
	LogLevel,
	type ILogger,
	type ILoggerService,
	type ILogServiceHost,
	type ILogSink,
	type LogEntry,
	type LogEntryLevel,
} from './log.js';

export interface LogServiceOptions {
	readonly sinks?: readonly ILogSink[];
	readonly now?: () => number;
	readonly onSinkError?: (entry: LogEntry, error: unknown) => void;
	readonly level?: LogLevel;
	readonly category?: string;
	readonly flush?: () => Promise<void>;
}

/** Multiplexes structured entries to runtime-selected sinks. */
export class LogService extends AbstractLoggerService<LogService> implements ILogServiceHost, ILogger, ILoggerService {
	private level: LogLevel;
	private readonly disposed = this._register(new Emitter<void>());
	readonly onDidDispose = this.disposed.event;
	private readonly history: LogEntry[] = [];
	private historyBytes = 0;
	private readonly levelChanged = this._register(new Emitter<LogLevel>());
	readonly onDidChangeLogLevel = this.levelChanged.event;
	private readonly sinks = new Set<ILogSink>();
	private readonly now: () => number;
	private readonly onSinkError: (entry: LogEntry, error: unknown) => void;

	constructor(private readonly options: LogServiceOptions = {}) {
		super();
		this.level = options.level ?? DEFAULT_LOG_LEVEL;
		this.now = options.now ?? Date.now;
		this.onSinkError = options.onSinkError ?? reportSinkFailure;
		for (const sink of options.sinks ?? []) this.sinks.add(sink);
		this._register(toDisposable(() => this.sinks.clear()));
	}

	getLevel(): LogLevel {
		return this.level;
	}
	setLevel(level: LogLevel): void {
		if (this.level === level) return;
		this.level = level;
		this.levelChanged.fire(level);
	}

	async flush(): Promise<void> {
		await this.options.flush?.();
	}

	protected doCreateLogger(category: string): LogService {
		if (!category.trim()) throw new TypeError('Log category must not be empty');
		return new LogService({
			category,
			level: this.level,
			now: this.now,
			sinks: [{ log: entry => this.dispatch(entry) }],
			onSinkError: this.onSinkError,
			flush: () => this.flush(),
		});
	}

	registerSink(sink: ILogSink, replay = false): IDisposable {
		this.sinks.add(sink);
		if (replay) for (const entry of this.history) sink.log(entry);
		return toDisposable(() => this.sinks.delete(sink));
	}

	trace(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		this.publishArguments(LogLevel.Trace, categoryOrMessage, messageOrArgument, arguments_);
	}
	debug(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		this.publishArguments(LogLevel.Debug, categoryOrMessage, messageOrArgument, arguments_);
	}
	info(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		this.publishArguments(LogLevel.Info, categoryOrMessage, messageOrArgument, arguments_);
	}
	warn(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		this.publishArguments(LogLevel.Warning, categoryOrMessage, messageOrArgument, arguments_);
	}
	error(categoryOrError: string | Error, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		if (categoryOrError instanceof Error)
			this.publish(
				LogLevel.Error,
				this.options.category ?? 'application',
				categoryOrError.message,
				categoryOrError,
			);
		else this.publishArguments(LogLevel.Error, categoryOrError, messageOrArgument, arguments_);
	}

	private publishArguments(
		level: LogEntryLevel,
		categoryOrMessage: string,
		messageOrArgument: unknown,
		arguments_: readonly unknown[],
	): void {
		if (!this.options.category && typeof messageOrArgument === 'string') {
			this.publish(
				level,
				categoryOrMessage,
				formatMessage(messageOrArgument, arguments_),
				arguments_.find(argument => argument instanceof Error),
			);
			return;
		}
		const values = messageOrArgument === undefined ? arguments_ : [messageOrArgument, ...arguments_];
		this.publish(
			level,
			this.options.category ?? 'application',
			formatMessage(categoryOrMessage, values),
			values.find(argument => argument instanceof Error),
		);
	}

	private publish(level: LogEntryLevel, category: string, message: string, error?: unknown): void {
		if (!canLog(this.level, level) || this.isDisposed) return;
		if (!category.trim()) throw new TypeError('Log category must not be empty');
		if (!message.trim()) throw new TypeError('Log message must not be empty');
		const entry: LogEntry = Object.freeze({ timestampMillis: this.now(), level, category, message, error });
		this.dispatch(entry);
	}

	protected override disposeCore(): void {
		this.disposed.fire();
		this.history.length = 0;
		super.disposeCore();
	}

	private dispatch(entry: LogEntry): void {
		if (this.isDisposed) return;
		// Late subscribers need text diagnostics, never retained exception object graphs.
		const error =
			entry.error instanceof Error
				? (entry.error.stack ?? entry.error.message)
				: entry.error === undefined
					? undefined
					: String(entry.error);
		this.history.push(Object.freeze({ ...entry, error }));
		this.historyBytes += entry.message.length + (error?.length ?? 0);
		while (this.historyBytes > 512 * 1024 || this.history.length > 2000) {
			const removed = this.history.shift()!;
			this.historyBytes -= removed.message.length + String(removed.error ?? '').length;
		}
		for (const sink of this.sinks) {
			try {
				sink.log(entry);
			} catch (sinkError) {
				try {
					this.onSinkError(entry, sinkError);
				} catch {
					// A disconnected console can also break the failure reporter. Keep the
					// original entry flowing to other sinks without feeding the global error handler.
				}
			}
		}
	}
}

function formatMessage(message: string, arguments_: readonly unknown[]): string {
	const values = arguments_.filter(argument => !(argument instanceof Error && argument.message === message));
	if (values.length === 0) return message;
	return `${message} ${values.map(argument => (argument instanceof Error ? argument.message : typeof argument === 'string' ? argument : JSON.stringify(argument))).join(' ')}`;
}

function reportSinkFailure(entry: LogEntry, error: unknown): void {
	console.error(`Log sink failed while handling [${entry.category}] ${entry.message}`, error);
}
