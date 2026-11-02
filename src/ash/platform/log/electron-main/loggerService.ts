import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HostLogRequest, HostLogResponse } from '../../../../../.build/protocol/typescript/HostLogs.js';
import { decodeHostLogResponse } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ConsoleLogSink } from '../common/consoleLogSink.js';
import { AbstractLoggerService, type LogEntry, type ILogFile, type ILogFileCursor, type ILogFileReadResult } from '../common/log.js';
import { LogService } from '../common/logServiceImpl.js';

interface LoggerOptions {
	readonly logsHome: string;
	readonly maxFileBytes?: number;
	readonly retainedSessions?: number;
	readonly appServerLog?: () => Promise<string | undefined>;
	/** The product host starts the packaged Rust helper, independent of App Server readiness. */
	readonly start: () => ChildProcessWithoutNullStreams;
}

const MaxFrameBytes = 8 * 1024 * 1024;
const MaxPendingRequests = 128;

/** Electron's ordered pipe adapter. Rust owns all files, retention and read cursors. */
export class LoggerService extends AbstractLoggerService<LogService> {
	private child: ChildProcessWithoutNullStreams | undefined;
	private session: string | undefined;
	private buffer = Buffer.alloc(0);
	private diagnostic = '';
	private pending: DeferredPromise<HostLogResponse> | undefined;
	private serial = Promise.resolve();
	private pendingBytes = 0;
	private pendingRequests = 0;
	private failure: Error | undefined;
	private readonly exited = new DeferredPromise<number>();
	private closing: Promise<void> | undefined;

	constructor(private readonly options: LoggerOptions) {
		super();
		this._register(toDisposable(() => {
			this.fail(new Error('Desktop logger disposed'));
			this.child?.stdin.end();
			if (this.child && this.child.exitCode === null) this.child.kill();
		}));
	}

	get sessionPath(): string {
		if (!this.session) throw new Error('Desktop logger is not open');
		return this.session;
	}

	async initialize(): Promise<void> {
		this.assertNotDisposed();
		if (this.child) throw new Error('Desktop logger is already initialized');
		const child = this.child = this.options.start();
		child.stdout.on('data', (chunk: Buffer) => this.accept(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { this.diagnostic = (this.diagnostic + chunk).slice(-64 * 1024); });
		child.stdin.on('error', error => this.fail(error));
		child.once('error', error => { this.fail(error); void this.exited.complete(-1); });
		child.once('close', (code, signal) => {
			void this.exited.complete(code ?? -1);
			if (!this.closing || this.pending) this.fail(new Error(`Rust logger exited (${code ?? signal}): ${this.diagnostic}`));
		});
		const startupTimeout = setTimeout(() => { this.fail(new Error('Rust logger initialization timed out')); child.kill('SIGKILL'); }, 10_000);
		try {
			const response = await this.request({
				op: 'initialize', logsHome: this.options.logsHome,
				maxFileBytes: this.options.maxFileBytes ?? 5 * 1024 * 1024,
				retainedSessions: this.options.retainedSessions ?? 10, processId: process.pid
			});
			if (response.kind !== 'initialized' || response.version !== 1) throw new Error('Unsupported Rust logger contract');
			this.session = response.sessionPath;
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			child.kill();
			throw error;
		} finally { clearTimeout(startupTimeout); }
	}

	protected doCreateLogger(category: string): LogService {
		if (!category.trim()) throw new TypeError('Invalid logger category');
		return new LogService({
			flush: () => this.flush(), sinks: [new ConsoleLogSink(), {
				log: entry => {
					void this.log('main', { ...entry, category: entry.category === 'application' ? category : entry.category })
						.catch(error => console.error('Failed to persist Desktop log', error));
				},
			}]
		});
	}

	async log(source: string, entry: LogEntry): Promise<void> {
		const error = entry.error instanceof Error ? entry.error.stack ?? entry.error.message : entry.error === undefined ? undefined : String(entry.error);
		await this.expectOk({ op: 'append', source, entry: { ...entry, error } });
	}

	async getLogFiles(windowSource: string): Promise<readonly ILogFile[]> {
		const response = await this.request({ op: 'list', windowSource, appServerLog: await this.options.appServerLog?.() ?? null });
		if (response.kind !== 'listed') throw new Error('Unexpected Rust logger list response');
		return response.files;
	}

	async readLogFile(id: string, cursor?: ILogFileCursor): Promise<ILogFileReadResult> {
		const response = await this.request({ op: 'read', id, cursor: cursor ?? null });
		if (response.kind !== 'read') throw new Error('Unexpected Rust logger read response');
		return response.result;
	}

	cleanUpLogs(): Promise<void> { return this.expectOk({ op: 'cleanUp' }); }
	flush(): Promise<void> { return this.expectOk({ op: 'flush' }); }

	close(): Promise<void> {
		if (this.closing) return this.closing;
		if (!this.child) return Promise.resolve();
		const operation = this.expectOk({ op: 'close' });
		const timeout = setTimeout(() => { this.child?.kill('SIGKILL'); }, 5_000);
		this.closing = (async () => {
			try { await operation; }
			finally {
				this.child?.stdin.end();
				try {
					if (await this.exited.p !== 0) throw new Error('Rust logger did not close successfully');
				} finally { clearTimeout(timeout); }
			}
		})();
		return this.closing;
	}

	private async expectOk(request: HostLogRequest): Promise<void> {
		if ((await this.request(request)).kind !== 'ok') throw new Error('Unexpected Rust logger acknowledgment');
	}

	private request(request: HostLogRequest): Promise<HostLogResponse> {
		this.assertNotDisposed();
		if (!this.child || this.closing) return Promise.reject(new Error('Desktop logger is not open'));
		const frame = Buffer.from(JSON.stringify(request) + '\n');
		// Reserve one close frame so a full producer queue can still drain on quit.
		if (request.op !== 'close' && (this.pendingRequests >= MaxPendingRequests || frame.length > MaxFrameBytes || this.pendingBytes + frame.length > MaxFrameBytes)) {
			return Promise.reject(new Error('Rust logger pending limit exceeded'));
		}
		this.pendingRequests++;
		this.pendingBytes += frame.length;
		const operation = this.serial.then(async () => {
			if (this.failure) throw this.failure;
			const pending = this.pending = new DeferredPromise<HostLogResponse>();
			try { this.child!.stdin.write(frame, error => { if (error) this.fail(error); }); }
			catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
			const response = await pending.p;
			if (response.kind === 'failure') throw new Error(`${response.reason}: ${response.message}`);
			return response;
		});
		this.serial = operation.then(() => undefined, () => undefined);
		return operation.finally(() => { this.pendingRequests--; this.pendingBytes -= frame.length; });
	}

	private accept(chunk: Buffer): void {
		if (this.failure) return;
		try {
			if (this.buffer.length + chunk.length > MaxFrameBytes) throw new Error('Rust logger response exceeds frame limit');
			this.buffer = Buffer.concat([this.buffer, chunk]);
			let newline: number;
			while ((newline = this.buffer.indexOf(10)) >= 0) {
				const response = decodeHostLogResponse(JSON.parse(this.buffer.subarray(0, newline).toString('utf8')));
				this.buffer = newline + 1 < this.buffer.length ? this.buffer.subarray(newline + 1) : Buffer.alloc(0);
				const pending = this.pending;
				if (!pending) throw new Error('Unexpected Rust logger response');
				this.pending = undefined;
				void pending.complete(response);
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			this.child?.kill();
		}
	}

	private fail(error: Error): void {
		this.failure ??= error;
		this.buffer = Buffer.alloc(0);
		void this.pending?.error(this.failure);
		this.pending = undefined;
	}
}
