import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { ConsoleLogSink } from '../common/consoleLogSink.js';
import type { ILoggerService, LogEntry } from '../common/log.js';
import { LogService } from '../common/logServiceImpl.js';

interface LoggerOptions {
	readonly logsHome: string;
	readonly maxFileBytes?: number;
	readonly retainedSessions?: number;
}

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

	constructor(options: LoggerOptions) {
		super();
		this.logsHome = resolve(options.logsHome);
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
