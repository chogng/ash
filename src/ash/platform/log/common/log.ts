import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const LogLevel = Object.freeze({
	Off: 'off',
	Trace: 'trace',
	Debug: 'debug',
	Info: 'information',
	Warning: 'warning',
	Error: 'error',
} as const);

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
export type LogEntryLevel = Exclude<LogLevel, typeof LogLevel.Off>;
export const DEFAULT_LOG_LEVEL: LogLevel = LogLevel.Info;

export interface LogEntry {
	readonly timestampMillis: number;
	readonly level: LogEntryLevel;
	readonly category: string;
	readonly message: string;
	readonly error: unknown | undefined;
}

export interface ILogSink {
	log(entry: LogEntry): void;
}

/** Structured application logging independent of a console or UI sink. */
export interface ILogService {
	trace(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void;
	debug(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void;
	info(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void;
	warn(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void;
	error(categoryOrError: string | Error, messageOrArgument?: unknown, ...arguments_: unknown[]): void;
}

export interface ILogServiceHost extends ILogService {
	registerSink(sink: ILogSink, replay?: boolean): IDisposable;
}

export const ILogService = createServiceIdentifier<ILogService>('logService');
export const ILoggerService = createServiceIdentifier<ILoggerService>('loggerService');

export interface ILoggerService {
	createLogger(id: string, options?: ILoggerOptions): ILogger;
	getLogger(id: string): ILogger | undefined;
	getRegisteredLoggers(): Iterable<ILoggerResource>;
	readonly onDidChangeLoggers: Event<DidChangeLoggersEvent>;
	readonly onDidChangeVisibility: Event<readonly [string, boolean]>;
	setVisibility(id: string, visible: boolean): void;
	/** Host-owned saved logs, when this runtime has persistent logging. */
	readonly files?: ILogFileService;
}

export interface ILoggerOptions {
	readonly extensionId?: string;
	readonly logLevel?: LogLevel;
	readonly name?: string;
	readonly hidden?: boolean;
}

export interface ILoggerResource extends ILoggerOptions {
	readonly id: string;
}

export interface DidChangeLoggersEvent {
	readonly added: Iterable<ILoggerResource>;
	readonly removed: Iterable<ILoggerResource>;
}

/** Owns logger identity and lifetime; hosts choose only the persistence sinks. */
export abstract class AbstractLoggerService<T extends ILogger = ILogger> extends Disposable implements ILoggerService {
	private readonly loggers = new Map<string, { logger: T; info: ILoggerResource; subscription: IDisposable }>();
	private readonly loggersChanged = this._register(new Emitter<DidChangeLoggersEvent>());
	readonly onDidChangeLoggers = this.loggersChanged.event;
	private readonly visibilityChanged = this._register(new Emitter<readonly [string, boolean]>());
	readonly onDidChangeVisibility = this.visibilityChanged.event;

	createLogger(id: string, options: ILoggerOptions = {}): T {
		if (!id.trim() || id.length > 512 || id.includes('\0')) throw new TypeError('Invalid logger id');
		if (this.isDisposed) throw new ReferenceError('Logger service is disposed');
		const existing = this.loggers.get(id);
		if (existing) return existing.logger;
		const logger = this.doCreateLogger(id);
		if (options.logLevel !== undefined) logger.setLevel(options.logLevel);
		const info = Object.freeze({ ...options, id });
		const subscription = logger.onDidDispose(() => {
			const current = this.loggers.get(id)!;
			this.loggers.delete(id);
			subscription.dispose();
			this.loggersChanged.fire({ added: [], removed: [current.info] });
		});
		this.loggers.set(id, { logger, info, subscription });
		this.loggersChanged.fire({ added: [info], removed: [] });
		return logger;
	}

	protected abstract doCreateLogger(id: string): T;
	getLogger(id: string): T | undefined {
		return this.loggers.get(id)?.logger;
	}
	*getRegisteredLoggers(): Iterable<ILoggerResource> {
		for (const { info } of this.loggers.values()) yield info;
	}
	setVisibility(id: string, visible: boolean): void {
		const entry = this.loggers.get(id);
		if (!entry || Boolean(entry.info.hidden) === !visible) return;
		entry.info = Object.freeze({ ...entry.info, hidden: !visible });
		this.visibilityChanged.fire([id, visible]);
	}
	protected override disposeCore(): void {
		for (const { logger, subscription } of this.loggers.values()) {
			subscription.dispose();
			logger.dispose();
		}
		this.loggers.clear();
		super.disposeCore();
	}
}

export interface ILogFile {
	readonly id: string;
	readonly source: string;
	readonly format: 'jsonl' | 'text';
	readonly live: boolean;
	readonly currentWindow: boolean;
}

export interface ILogFileCursor {
	readonly generation: string;
	readonly offset: number;
}

export interface ILogFileReadResult {
	readonly text: string;
	readonly cursor: ILogFileCursor;
	/** The source rotated, truncated, or exceeded the bounded read window. */
	readonly gap: boolean;
}

/** Reads only host-enumerated sources; callers never supply filesystem paths. */
export interface ILogFileService {
	list(): Promise<readonly ILogFile[]>;
	read(id: string, cursor?: ILogFileCursor): Promise<ILogFileReadResult>;
}

/** A logger owns its filtering and the lifetime of its sink subscriptions. */
export interface ILogger extends ILogServiceHost, IDisposable {
	readonly onDidDispose: Event<void>;
	readonly onDidChangeLogLevel: Event<LogLevel>;
	getLevel(): LogLevel;
	setLevel(level: LogLevel): void;
	flush(): Promise<void>;
}

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === 'string' && Object.values(LogLevel).includes(value as LogLevel);
}

/** The startup resource uses the standard short spellings, independently of entry severity names. */
export function parseLogLevel(value: string): LogLevel | undefined {
	switch (value.toLowerCase()) {
		case 'trace':
			return LogLevel.Trace;
		case 'debug':
			return LogLevel.Debug;
		case 'info':
		case 'information':
			return LogLevel.Info;
		case 'warn':
		case 'warning':
			return LogLevel.Warning;
		case 'error':
			return LogLevel.Error;
		case 'off':
			return LogLevel.Off;
		default:
			return undefined;
	}
}

export function LogLevelToString(level: LogLevel): string {
	return level === LogLevel.Info ? 'info' : level === LogLevel.Warning ? 'warn' : level;
}

export function canLog(loggerLevel: LogLevel, messageLevel: LogLevel): boolean {
	if (loggerLevel === LogLevel.Off) return false;
	return logLevelOrder(loggerLevel) <= logLevelOrder(messageLevel);
}

export function log(logger: ILogService, level: LogLevel, message: string): void {
	switch (level) {
		case LogLevel.Trace:
			logger.trace(message);
			break;
		case LogLevel.Debug:
			logger.debug(message);
			break;
		case LogLevel.Info:
			logger.info(message);
			break;
		case LogLevel.Warning:
			logger.warn(message);
			break;
		case LogLevel.Error:
			logger.error(message);
			break;
		case LogLevel.Off:
			break;
	}
}

export class ConsoleLogger implements ILogService {
	constructor(
		private readonly category = 'application',
		private readonly target: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
	) {}
	trace(message: string, argument?: unknown, ...arguments_: unknown[]): void {
		this.write('debug', message, argument, arguments_);
	}
	debug(message: string, argument?: unknown, ...arguments_: unknown[]): void {
		this.write('debug', message, argument, arguments_);
	}
	info(message: string, argument?: unknown, ...arguments_: unknown[]): void {
		this.write('info', message, argument, arguments_);
	}
	warn(message: string, argument?: unknown, ...arguments_: unknown[]): void {
		this.write('warn', message, argument, arguments_);
	}
	error(message: string | Error, argument?: unknown, ...arguments_: unknown[]): void {
		this.write(
			'error',
			message instanceof Error ? message.message : message,
			argument,
			message instanceof Error ? [message, ...arguments_] : arguments_,
		);
	}

	private write(
		method: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		argument: unknown,
		arguments_: readonly unknown[],
	): void {
		const values = argument === undefined ? arguments_ : [argument, ...arguments_];
		this.target[method](`[${this.category}] ${message}`, ...values);
	}
}

export class NullLoggerService implements ILogServiceHost, ILoggerService, ILogger {
	readonly onDidChangeLogLevel = Event.None;
	readonly onDidDispose = Event.None;
	readonly onDidChangeLoggers = Event.None;
	readonly onDidChangeVisibility = Event.None;
	getLogger(_id: string): ILogger | undefined {
		return undefined;
	}
	getRegisteredLoggers(): Iterable<ILoggerResource> {
		return [];
	}
	setVisibility(_id: string, _visible: boolean): void {}
	getLevel(): LogLevel {
		return LogLevel.Off;
	}
	setLevel(_level: LogLevel): void {}
	async flush(): Promise<void> {}
	dispose(): void {}
	[Symbol.dispose](): void {
		this.dispose();
	}
	trace(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	debug(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	info(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	warn(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	error(_categoryOrError: string | Error, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	registerSink(_sink: ILogSink): IDisposable {
		return { dispose() {}, [Symbol.dispose]() {} };
	}
	createLogger(_category: string): ILogger {
		return this;
	}
}

function logLevelOrder(level: LogLevel): number {
	switch (level) {
		case LogLevel.Trace:
			return 1;
		case LogLevel.Debug:
			return 2;
		case LogLevel.Info:
			return 3;
		case LogLevel.Warning:
			return 4;
		case LogLevel.Error:
			return 5;
		case LogLevel.Off:
			return Number.POSITIVE_INFINITY;
	}
}
