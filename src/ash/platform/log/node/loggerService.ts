import { readdir, open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { isRecord } from '../../../base/common/types.js';
import { ConsoleLogSink } from '../common/consoleLogSink.js';
import { AbstractLoggerService, type LogEntry, type ILogFile, type ILogFileCursor, type ILogFileReadResult } from '../common/log.js';
import { LogService } from '../common/logServiceImpl.js';
import { LogFileWriter } from './logFileWriter.js';

interface LoggerOptions {
	readonly logsHome: string;
	readonly maxFileBytes?: number;
	readonly retainedSessions?: number;
	/** Lifecycle host resolves this through the daemon, which owns its log location. */
	readonly appServerLog?: () => Promise<string | undefined>;
}

const SessionName = /^\d{8}T\d{9}-[\da-f-]{36}$/;
const LogFileName = /^(main|window-[1-9]\d*)\.log(?:\.[12])?$/;
const MaxReadBytes = 1024 * 1024;

/** Owns Desktop log files and their retention; all writes and maintenance share one queue. */
export class LoggerService extends AbstractLoggerService<LogService> {
	public readonly sessionPath: string;
	private readonly logsHome: string;
	private readonly writer: LogFileWriter;
	private readonly appServerLog: LoggerOptions['appServerLog'];
	private appServerLogPath: string | undefined;

	constructor(options: LoggerOptions) {
		super();
		this.logsHome = resolve(options.logsHome);
		this.appServerLog = options.appServerLog;
		this.writer = new LogFileWriter(options);
		this.sessionPath = this.writer.sessionPath;
	}

	public async initialize(): Promise<void> {
		this.assertNotDisposed();
		await this.writer.initialize();
	}

	protected doCreateLogger(category: string): LogService {
		if (!category.trim()) { throw new TypeError('Invalid logger category'); }
		return new LogService({
			flush: () => this.flush(),
			sinks: [new ConsoleLogSink(), {
				log: entry => {
					void this.log('main', { ...entry, category: entry.category === 'application' ? category : entry.category })
						.catch(error => console.error('Failed to persist Desktop log', error));
				},
			}]
		});
	}

	public log(source: string, entry: LogEntry): Promise<void> {
		const error = entry.error instanceof Error ? entry.error.stack ?? entry.error.message : entry.error === undefined ? undefined : String(entry.error);
		const line = JSON.stringify({ ...entry, error, source, processId: process.pid }) + '\n';
		this.assertNotDisposed();
		return this.writer.append(source, line);
	}

	/** Enumerate retained files rather than maintaining a second history catalog. */
	public async getLogFiles(windowSource: string): Promise<readonly ILogFile[]> {
		this.assertNotDisposed();
		// Quiet windows still need a persistent source for Output to follow later.
		await this.writer.append(windowSource, '');
		await this.writer.settled();
		const current = this.sessionPath.slice(this.logsHome.length + 1);
		const files: ILogFile[] = [];
		for (const session of (await readdir(this.logsHome, { withFileTypes: true })).filter(entry => entry.isDirectory() && SessionName.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name))) {
			for (const file of await readdir(join(this.logsHome, session.name), { withFileTypes: true })) {
				if (!file.isFile() || !LogFileName.test(file.name)) continue;
				const source = file.name.replace(/\.log(?:\.[12])?$/, '');
				const live = session.name === current && file.name.endsWith('.log');
				files.push({ id: `${session.name}/${file.name}`, source, format: 'jsonl', live, currentWindow: live && source === windowSource });
			}
		}
		this.appServerLogPath ??= await this.appServerLog?.();
		if (this.appServerLogPath) {
			files.unshift({ id: 'app-server', source: 'app-server', format: 'text', live: true, currentWindow: false });
		}
		return files;
	}

	/** Bounded, complete-line reads share the existing writer's ordering and never mutate a log. */
	public async readLogFile(id: string, cursor?: ILogFileCursor): Promise<ILogFileReadResult> {
		this.assertNotDisposed();
		await this.writer.settled();
		let path: string;
		if (id === 'app-server' && this.appServerLogPath) {
			path = this.appServerLogPath;
		} else {
			const [session, file, extra] = id.split('/');
			if (!session || !file || extra !== undefined || !SessionName.test(session) || !LogFileName.test(file)) throw new TypeError('Invalid log file identity');
			const directory = join(this.logsHome, session);
			// A session directory cannot redirect the authenticated reader outside the log owner.
			if (await realpath(directory) !== join(await realpath(this.logsHome), session)) throw new TypeError('Invalid log session directory');
			path = join(directory, file);
		}
		// O_NOFOLLOW is unavailable on some hosts. Reject redirected sources before
		// opening there as well; fstat below also verifies the opened descriptor.
		if (!(await lstat(path)).isFile()) throw new TypeError('Log source must be a regular file');
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new TypeError('Log source must be a regular file');
			const generation = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
			const sameFile = cursor?.generation === generation && cursor.offset <= stat.size;
			const requested = sameFile ? cursor.offset : 0;
			const start = Math.max(requested, stat.size - MaxReadBytes);
			const bytes = Buffer.alloc(Math.min(MaxReadBytes, stat.size - start));
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
			// Partial producer writes remain unread until their newline arrives. Skip an
			// incomplete first record after a bounded tail jump, including split UTF-8.
			const end = bytes.lastIndexOf(10, bytesRead - 1) + 1;
			const first = start > requested ? bytes.indexOf(10) + 1 : 0;
			const offset = end > 0 ? start + end : start;
			return {
				text: end > first ? bytes.subarray(first, end).toString('utf8') : '',
				cursor: { generation, offset },
				gap: start > requested || Boolean(cursor && !sameFile),
			};
		} finally {
			await handle.close();
		}
	}

	public cleanUpLogs(): Promise<void> {
		this.assertNotDisposed();
		return this.writer.cleanUpLogs();
	}

	public flush(): Promise<void> { return this.writer.flush(); }
	public close(): Promise<void> { return this.writer.close(); }
}
