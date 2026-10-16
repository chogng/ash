import { appendFile, mkdir, readdir, rename, rm, open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { ConsoleLogSink } from '../common/consoleLogSink.js';
import type { ILoggerService, LogEntry, ILogFile, ILogFileCursor, ILogFileReadResult } from '../common/log.js';
import { LogService } from '../common/logServiceImpl.js';

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
export class LoggerService extends Disposable implements ILoggerService {
	public readonly sessionPath: string;
	private readonly fileSizes = new Map<string, number>();
	private readonly logsHome: string;
	private readonly maxFileBytes: number;
	private readonly retainedSessions: number;
	private queue: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private initialized = false;
	private failure: unknown;
	private readonly appServerLog: LoggerOptions['appServerLog'];
	private appServerLogPath: string | undefined;

	constructor(options: LoggerOptions) {
		super();
		this.logsHome = resolve(options.logsHome);
		this.appServerLog = options.appServerLog;
		this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
		this.retainedSessions = options.retainedSessions ?? 10;
		if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1 || !Number.isSafeInteger(this.retainedSessions) || this.retainedSessions < 1) {
			throw new TypeError('Invalid log retention limits');
		}
		const timestamp = new Date().toISOString().replace(/[-:.Z]/g, '');
		this.sessionPath = join(this.logsHome, `${timestamp}-${randomUUID()}`);
	}

	public async initialize(): Promise<void> {
		this.assertNotDisposed();
		await mkdir(this.sessionPath, { recursive: true });
		this.initialized = true;
	}

	public createLogger(category: string): LogService {
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
		if (!/^(main|window-[1-9]\d*)$/.test(source)) { throw new TypeError('Invalid log source'); }
		const error = entry.error instanceof Error ? entry.error.stack ?? entry.error.message : entry.error === undefined ? undefined : String(entry.error);
		const line = JSON.stringify({ ...entry, error, source, processId: process.pid }) + '\n';
		const bytes = Buffer.byteLength(line);
		if (bytes > this.maxFileBytes) { throw new RangeError('Log entry exceeds file limit'); }
		return this.run(async () => {
			const path = join(this.sessionPath, `${source}.log`);
			let size = this.fileSizes.get(source) ?? 0;
			if (size > 0 && size + bytes > this.maxFileBytes) {
				await rm(`${path}.2`, { force: true });
				try { await rename(`${path}.1`, `${path}.2`); }
				catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') { throw error; } }
				await rename(path, `${path}.1`);
				size = 0;
			}
			await appendFile(path, line, 'utf8');
			this.fileSizes.set(source, size + bytes);
		});
	}

	/** Enumerate retained files rather than maintaining a second history catalog. */
	public async getLogFiles(windowSource: string): Promise<readonly ILogFile[]> {
		this.assertNotDisposed();
		await this.queue;
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
		await this.queue;
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
		return this.run(async () => {
			const sessions = (await readdir(this.logsHome, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && /^\d{8}T\d{9}-[\da-f-]{36}$/.test(entry.name) && join(this.logsHome, entry.name) !== this.sessionPath)
				.sort((left, right) => right.name.localeCompare(left.name));
			for (const entry of sessions.slice(this.retainedSessions - 1)) {
				const target = resolve(this.logsHome, entry.name);
				const withinRoot = relative(this.logsHome, target);
				if (!withinRoot || withinRoot.startsWith('..') || isAbsolute(withinRoot)) { throw new Error('Log cleanup escaped its directory'); }
				await rm(target, { recursive: true });
			}
		});
	}

	public async flush(): Promise<void> {
		await this.queue;
		if (this.failure !== undefined) { throw this.failure; }
	}

	public close(): Promise<void> {
		this.closing ??= this.flush();
		return this.closing;
	}

	private run(operation: () => Promise<void>): Promise<void> {
		this.assertNotDisposed();
		if (!this.initialized || this.closing) { throw new Error('Desktop logger is not open'); }
		const result = this.queue.then(operation);
		this.queue = result.catch(error => { this.failure ??= error; });
		return result;
	}
}
