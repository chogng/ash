import { log } from '../../../base/common/console.js';
import type { ILogSink, LogEntry } from './log.js';
import { LogLevel } from './log.js';

const consoleMethods = {
	[LogLevel.Trace]: 'debug',
	[LogLevel.Debug]: 'debug',
	[LogLevel.Info]: 'info',
	[LogLevel.Warning]: 'warn',
	[LogLevel.Error]: 'error',
} as const;

/** Development and host-console projection of structured log entries. */
export class ConsoleLogSink implements ILogSink {
	constructor(private readonly target: Pick<Console, 'debug' | 'error' | 'info' | 'warn'> = console) { }

	log(entry: LogEntry): void {
		const args: [string, ...unknown[]] = [entry.message];
		if (entry.error !== undefined) {
			args.push(entry.error);
		}
		log({ severity: consoleMethods[entry.level], arguments: args }, entry.category, this.target);
	}
}
