import { Disposable, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { LogLevel, type ILogServiceHost, type ILogSink, type LogEntry, type LogEntryLevel } from "./log.js";

export interface LogServiceOptions {
	readonly sinks?: readonly ILogSink[];
	readonly now?: () => number;
	readonly onSinkError?: (entry: LogEntry, error: unknown) => void;
}

/** Multiplexes structured entries to runtime-selected sinks. */
export class LogService extends Disposable implements ILogServiceHost {
	private readonly sinks = new Set<ILogSink>();
	private readonly now: () => number;
	private readonly onSinkError: (entry: LogEntry, error: unknown) => void;

	constructor(options: LogServiceOptions = {}) {
		super();
		this.now = options.now ?? Date.now;
		this.onSinkError = options.onSinkError ?? reportSinkFailure;
		for (const sink of options.sinks ?? []) this.sinks.add(sink);
		this._register(toDisposable(() => this.sinks.clear()));
	}

	registerSink(sink: ILogSink): IDisposable {
		this.sinks.add(sink);
		return toDisposable(() => this.sinks.delete(sink));
	}

	trace(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void { this.publishArguments(LogLevel.Trace, categoryOrMessage, messageOrArgument, arguments_); }
	debug(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void { this.publishArguments(LogLevel.Debug, categoryOrMessage, messageOrArgument, arguments_); }
	info(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void { this.publishArguments(LogLevel.Info, categoryOrMessage, messageOrArgument, arguments_); }
	warn(categoryOrMessage: string, messageOrArgument?: unknown, ...arguments_: unknown[]): void { this.publishArguments(LogLevel.Warning, categoryOrMessage, messageOrArgument, arguments_); }
	error(categoryOrError: string | Error, messageOrArgument?: unknown, ...arguments_: unknown[]): void {
		if (categoryOrError instanceof Error) this.publish(LogLevel.Error, "application", categoryOrError.message, categoryOrError);
		else this.publishArguments(LogLevel.Error, categoryOrError, messageOrArgument, arguments_);
	}

	private publishArguments(level: LogEntryLevel, categoryOrMessage: string, messageOrArgument: unknown, arguments_: readonly unknown[]): void {
		if (typeof messageOrArgument === "string") {
			this.publish(level, categoryOrMessage, formatMessage(messageOrArgument, arguments_), arguments_.find(argument => argument instanceof Error));
			return;
		}
		const values = messageOrArgument === undefined ? arguments_ : [messageOrArgument, ...arguments_];
		this.publish(level, "application", formatMessage(categoryOrMessage, values), values.find(argument => argument instanceof Error));
	}

	private publish(level: LogEntryLevel, category: string, message: string, error?: unknown): void {
		if (!category.trim()) throw new TypeError("Log category must not be empty");
		if (!message.trim()) throw new TypeError("Log message must not be empty");
		const entry: LogEntry = Object.freeze({ timestampMillis: this.now(), level, category, message, error });
		for (const sink of this.sinks) {
			try { sink.log(entry); }
			catch (sinkError) { this.onSinkError(entry, sinkError); }
		}
	}
}

function formatMessage(message: string, arguments_: readonly unknown[]): string {
	if (arguments_.length === 0) return message;
	return `${message} ${arguments_.map(argument => argument instanceof Error ? argument.message : typeof argument === "string" ? argument : JSON.stringify(argument)).join(" ")}`;
}

function reportSinkFailure(entry: LogEntry, error: unknown): void {
	console.error(`Log sink failed while handling [${entry.category}] ${entry.message}`, error);
}
