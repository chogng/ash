import { Disposable, setDisposableOwner, toDisposable } from "../../../../base/common/lifecycle.js";
import { RunOnceScheduler } from '../../../../base/common/async.js';
import type { IAppServerApi } from "../../../../platform/agentHost/common/appServerApi.js";
import type { ILogger, ILogSink, LogEntry, ILogFile, ILogFileCursor, ILogFileService } from "../../../../platform/log/common/log.js";
import { validateLogEntry } from '../../../../platform/log/common/logIpc.js';
import { windowLogGroup, windowLogId } from '../../log/common/logConstants.js';
import { localize } from '../../../../nls.js';
import type { IOutputChannel, IOutputService, IOutputEntryInput } from "../common/output.js";

/** Owns built-in Window and App Server diagnostic Output channels. */
export class SystemOutputService extends Disposable implements ILogSink {
	private readonly windowChannel: IOutputChannel;
	private readonly appServerChannel: IOutputChannel;
	private savedWindow: boolean;

	constructor(output: IOutputService, appServer: IAppServerApi, logger?: ILogger, files?: ILogFileService) {
		super();
		this.savedWindow = Boolean(files);
		this.windowChannel = this._register(output.createChannel({
			id: windowLogId, label: windowLogGroup.name, kind: 'log', source: 'core',
			logger: logger ? { label: localize('output.workbenchLogger', 'Workbench'), control: logger } : undefined,
		}));
		this.appServerChannel = this._register(output.createChannel({
			id: files ? 'app-server-connection' : 'app-server',
			label: files ? localize('output.appServerConnection', 'App Server Connection') : localize('output.appServer', 'App Server'),
			kind: 'log', source: 'core',
		}));
		const appendConnection = (level: LogEntry['level'], message: string, error?: unknown): void => {
			this.appServerChannel.appendLine(outputLogEntry({ timestampMillis: Date.now(), level, category: 'connection', message, error }));
		};
		const connection = appServer.onConnectionState(state => appendConnection(
			state === 'crashed' ? 'error' : state === 'restarting' ? 'warning' : 'information',
			localize('output.connectionState', 'App Server connection is {0}.', state),
		));
		this._register(toDisposable(() => connection.dispose()));
		void appServer.getConnectionState().then(state => {
			if (!this.isDisposed) appendConnection(
				state === 'crashed' ? 'error' : 'information',
				localize('output.initialConnectionState', 'Initial App Server connection state: {0}.', state),
			);
		}).catch(error => {
			if (!this.isDisposed) appendConnection(
				'error', localize('output.connectionError', 'Could not read App Server connection state: {0}', errorMessage(error)), error,
			);
		});
		if (files) {
			logger?.info('logs', localize('output.windowLogReady', 'Window logging initialized.'));
			void files.list().then(sources => {
				if (this.isDisposed) return;
				const window = sources.find(source => source.currentWindow);
				this.savedWindow = Boolean(window);
				if (window) openLogOutput(output, files, window, this.windowChannel);
				const otherSources = sources.filter(source => source.live && !source.currentWindow && (source.source === 'main' || source.source === 'app-server'));
				for (const source of otherSources) {
					this._register(openLogOutput(output, files, source));
				}
			}).catch(error => {
				if (this.isDisposed) return;
				this.savedWindow = false;
				this.windowChannel.appendLine({
					severity: 'error', category: 'logs',
					text: localize('output.savedLogError', 'Could not read saved logs: {0}', errorMessage(error)),
				});
			});
		}
	}

	log(entry: LogEntry): void {
		if (!this.savedWindow) this.windowChannel.appendLine(outputLogEntry(entry));
	}
}

/** A file is authoritative; the channel is only a bounded read cache. */
export function openLogOutput(output: IOutputService, files: ILogFileService, source: ILogFile, existing?: IOutputChannel): IOutputChannel {
	const id = source.currentWindow ? windowLogId : source.live && source.source === 'app-server' ? 'app-server' : `saved-log.${encodeURIComponent(source.id)}`;
	const present = existing ?? output.getChannel(id);
	if (present && !existing) return present;
	// Raw files are streams, so text filters match model lines rather than an
	// arbitrary filesystem read chunk. Only structured records use log filtering.
	const channel = present ?? output.createChannel({ id, label: savedLogLabel(source), kind: source.format === 'jsonl' ? 'log' : 'output', source: 'core' });
	const reader = new LogOutputReader(channel, files, source);
	setDisposableOwner(reader, channel);
	return channel;
}

export function savedLogLabel(source: ILogFile): string {
	let label = source.source;
	if (source.currentWindow) label = windowLogGroup.name;
	else if (source.source === 'main') label = localize('output.main', 'Main');
	else if (source.source === 'app-server') label = localize('output.localAppServer', 'Local App Server');
	else if (/^window-\d+$/u.test(source.source)) label = localize('output.windowNumber', 'Window {0}', source.source.slice('window-'.length));
	if (source.live) return label;
	const rotation = /\.log\.([12])$/u.exec(source.id)?.[1];
	if (rotation) label = localize('output.rotatedLog', '{0} (rotated {1})', label, rotation);
	const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/u.exec(source.id);
	const session = time ? `${time[1]}-${time[2]}-${time[3]} ${time[4]}:${time[5]}:${time[6]} UTC` : source.id;
	return localize('output.savedLogLabel', '{0} — {1}', label, session);
}

class LogOutputReader extends Disposable {
	private cursor: ILogFileCursor | undefined;
	private failed = false;
	private clearVersion = 0;
	private readonly scheduler = this._register(new RunOnceScheduler(() => { void this.read(); }, 1_000));

	constructor(private readonly channel: IOutputChannel, private readonly files: ILogFileService, private readonly source: ILogFile) {
		super();
		this._register(channel.onDidDispose(() => this.dispose()));
		this._register(channel.onDidChange(change => {
			if (change.kind !== 'clear') return;
			this.clearVersion++;
			// A pre-clear snapshot must not refill the cache. Keep the incremental
			// cursor so the next read can deliver new output without replaying history.
		}));
		void this.read();
	}

	private async read(): Promise<void> {
		const clearVersion = this.clearVersion;
		try {
			const result = await this.files.read(this.source.id, this.cursor);
			if (this.isDisposed) return;
			this.cursor = result.cursor;
			if (clearVersion !== this.clearVersion) return;
			this.failed = false;
			if (result.gap) this.channel.appendLine({
				severity: 'warning', category: 'logs',
				text: localize('output.logGap', 'Earlier output is unavailable because this log rotated, was truncated, or exceeded the read limit.'),
			});
			if (this.source.format === 'text') {
				this.channel.append({ text: result.text, category: this.source.source });
			} else {
				for (const line of result.text.split('\n')) {
					if (!line) continue;
					try { this.channel.appendLine(outputLogEntry(validateLogEntry(JSON.parse(line)))); }
					catch {
						this.channel.appendLine({
							severity: 'warning', category: 'logs',
							text: localize('output.invalidLogRecord', 'Unrecognized saved log record: {0}', line),
						});
					}
				}
			}
		} catch (error) {
			if (this.isDisposed) return;
			if (!this.failed) this.channel.appendLine({
				severity: 'error', category: 'logs',
				text: localize('output.savedLogError', 'Could not read saved logs: {0}', errorMessage(error)),
			});
			this.failed = true;
		} finally {
			if (!this.isDisposed && this.source.live) this.scheduler.schedule();
		}
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}

/** Preserve producer time and metadata in both the shared text and structured filters. */
function outputLogEntry(entry: LogEntry): IOutputEntryInput {
	return {
		timestamp: entry.timestampMillis,
		severity: entry.level,
		category: entry.category,
		text: `${new Date(entry.timestampMillis).toISOString()} [${entry.level}] [${entry.category}] ${entry.message}${entry.error === undefined ? '' : `\n${errorMessage(entry.error)}`}`,
	};
}
