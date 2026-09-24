import type { ILogSink, LogEntry } from "./log.js";
import { LogLevel } from "./log.js";

/** Development and host-console projection of structured log entries. */
export class ConsoleLogSink implements ILogSink {
	constructor(private readonly target: Pick<Console, "debug" | "error" | "info" | "warn"> = console) {}

	log(entry: LogEntry): void {
		const message = `[${entry.category}] ${entry.message}`;
		const argumentsList = entry.error === undefined ? [message] : [message, entry.error];
		switch (entry.level) {
			case LogLevel.Trace:
			case LogLevel.Debug: this.target.debug(...argumentsList); break;
			case LogLevel.Info: this.target.info(...argumentsList); break;
			case LogLevel.Warning: this.target.warn(...argumentsList); break;
			case LogLevel.Error: this.target.error(...argumentsList); break;
		}
	}
}
