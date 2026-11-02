import { appendFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

interface LogFileWriterOptions {
	readonly logsHome: string;
	readonly maxFileBytes?: number;
	readonly retainedSessions?: number;
}

/** Shared Node-only persistence for Desktop and development tools. No product
 * service dependencies or transformed TypeScript are needed by build scripts. */
export class LogFileWriter {
	public readonly sessionPath: string;
	private readonly fileSizes = new Map<string, number>();
	private readonly logsHome: string;
	private readonly maxFileBytes: number;
	private readonly retainedSessions: number;
	private queue: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private initialized = false;
	private failure: unknown;

	constructor(options: LogFileWriterOptions) {
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
		await mkdir(this.sessionPath, { recursive: true });
		await writeFile(join(this.sessionPath, `.active-${process.pid}`), '');
		this.initialized = true;
	}

	public append(source: string, line: string): Promise<void> {
		if (!/^(main|window-[1-9]\d*)$/.test(source)) { throw new TypeError('Invalid log source'); }
		const bytes = Buffer.byteLength(line);
		if (bytes > this.maxFileBytes) { throw new RangeError('Log entry exceeds file limit'); }
		return this.run(async () => {
			const path = join(this.sessionPath, `${source}.log`);
			let size = this.fileSizes.get(source) ?? 0;
			if (size > 0 && size + bytes > this.maxFileBytes) {
				await rm(`${path}.2`, { force: true });
				try { await rename(`${path}.1`, `${path}.2`); }
				catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') { throw error; } }
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
			let retained = 0;
			for (const entry of sessions) {
				const target = resolve(this.logsHome, entry.name);
				const withinRoot = relative(this.logsHome, target);
				if (!withinRoot || withinRoot.startsWith('..') || isAbsolute(withinRoot)) { throw new Error('Log cleanup escaped its directory'); }
				// A long-running development watcher may be older than several new
				// sessions. Retention never removes a writer whose process is still alive.
				if ((await readdir(target)).some(file => {
					const match = /^\.active-([1-9]\d{0,9})$/.exec(file);
					if (!match) { return false; }
					try { process.kill(Number(match[1]), 0); return true; }
					catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
				})) { continue; }
				if (++retained < this.retainedSessions) { continue; }
				await rm(target, { recursive: true });
			}
		});
	}


	/** Reads wait for writes without consuming the producer's failure state. */
	public async settled(): Promise<void> { await this.queue; }

	public async flush(): Promise<void> {
		await this.queue;
		if (this.failure !== undefined) { throw this.failure; }
	}

	public close(): Promise<void> {
		this.closing ??= this.flush().then(() => rm(join(this.sessionPath, `.active-${process.pid}`), { force: true }));
		return this.closing;
	}

	private run(operation: () => Promise<void>): Promise<void> {
		if (!this.initialized || this.closing) { throw new Error('Desktop logger is not open'); }
		const result = this.queue.then(operation);
		this.queue = result.catch(error => { this.failure ??= error; });
		return result;
	}
}
