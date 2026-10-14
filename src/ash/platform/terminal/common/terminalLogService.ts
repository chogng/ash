import { Disposable } from '../../../base/common/lifecycle.js';
import { ILoggerService, LogLevel, type ILogger } from '../../log/common/log.js';
import { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import type { ITerminalLogService } from './terminal.js';

/** Terminal diagnostics share the host's authenticated sinks and persistence queue. */
export class TerminalLogService extends Disposable implements ITerminalLogService {
	private readonly logger: ILogger;
	readonly onDidChangeLogLevel;

	constructor(
		@ILoggerService loggers: ILoggerService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.logger = this._register(loggers.createLogger('terminal'));
		this.onDidChangeLogLevel = this.logger.onDidChangeLogLevel;
	}

	getLevel(): LogLevel { return this.logger.getLevel(); }
	setLevel(level: LogLevel): void { this.logger.setLevel(level); }
	flush(): Promise<void> { return this.logger.flush(); }

	trace(message: string, ...args: unknown[]): void { this.logger.trace(this.message(message), ...args); }
	debug(message: string, ...args: unknown[]): void { this.logger.debug(this.message(message), ...args); }
	info(message: string, ...args: unknown[]): void { this.logger.info(this.message(message), ...args); }
	warn(message: string, ...args: unknown[]): void { this.logger.warn(this.message(message), ...args); }
	error(message: string | Error, ...args: unknown[]): void {
		if (message instanceof Error) {
			this.logger.error(this.message(message.message), message, ...args);
		}
		else {
			this.logger.error(this.message(message), ...args);
		}
	}

	private message(message: string): string {
		return this.logger.getLevel() === LogLevel.Trace ? `[${this.workspace.getWorkspace().id.slice(0, 7)}] ${message}` : message;
	}
}
