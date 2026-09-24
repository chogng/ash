import type { IDisposable } from "../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export const LogLevel = Object.freeze({
	Off: "off",
	Trace: "trace",
	Debug: "debug",
	Info: "information",
	Warning: "warning",
	Error: "error",
} as const);

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];
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
	registerSink(sink: ILogSink): IDisposable;
}

export const ILogService = createServiceIdentifier<ILogService>("logService");
export const ILoggerService = createServiceIdentifier<ILoggerService>("loggerService");

export interface ILoggerService {
	createLogger(category: string): ILogService;
}

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && Object.values(LogLevel).includes(value as LogLevel);
}

export function canLog(loggerLevel: LogLevel, messageLevel: LogLevel): boolean {
	if (loggerLevel === LogLevel.Off) return false;
	return logLevelOrder(loggerLevel) <= logLevelOrder(messageLevel);
}

export function log(logger: ILogService, level: LogLevel, message: string): void {
	switch (level) {
		case LogLevel.Trace: logger.trace(message); break;
		case LogLevel.Debug: logger.debug(message); break;
		case LogLevel.Info: logger.info(message); break;
		case LogLevel.Warning: logger.warn(message); break;
		case LogLevel.Error: logger.error(message); break;
		case LogLevel.Off: break;
	}
}

export class ConsoleLogger implements ILogService {
	constructor(private readonly category = "application", private readonly target: Pick<Console, "debug" | "info" | "warn" | "error"> = console) {}
	trace(message: string, argument?: unknown, ...arguments_: unknown[]): void { this.write("debug", message, argument, arguments_); }
	debug(message: string, argument?: unknown, ...arguments_: unknown[]): void { this.write("debug", message, argument, arguments_); }
	info(message: string, argument?: unknown, ...arguments_: unknown[]): void { this.write("info", message, argument, arguments_); }
	warn(message: string, argument?: unknown, ...arguments_: unknown[]): void { this.write("warn", message, argument, arguments_); }
	error(message: string | Error, argument?: unknown, ...arguments_: unknown[]): void { this.write("error", message instanceof Error ? message.message : message, argument, message instanceof Error ? [message, ...arguments_] : arguments_); }

	private write(method: "debug" | "info" | "warn" | "error", message: string, argument: unknown, arguments_: readonly unknown[]): void {
		const values = argument === undefined ? arguments_ : [argument, ...arguments_];
		this.target[method](`[${this.category}] ${message}`, ...values);
	}
}

export class NullLoggerService implements ILogServiceHost, ILoggerService {
	trace(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	debug(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	info(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	warn(_categoryOrMessage: string, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	error(_categoryOrError: string | Error, _messageOrArgument?: unknown, ..._arguments: unknown[]): void {}
	registerSink(_sink: ILogSink): IDisposable { return { dispose() {}, [Symbol.dispose]() {} }; }
	createLogger(_category: string): ILogService { return this; }
}

function logLevelOrder(level: LogLevel): number {
	switch (level) {
		case LogLevel.Trace: return 1;
		case LogLevel.Debug: return 2;
		case LogLevel.Info: return 3;
		case LogLevel.Warning: return 4;
		case LogLevel.Error: return 5;
		case LogLevel.Off: return Number.POSITIVE_INFINITY;
	}
}
