import { execFile, type ChildProcess } from 'node:child_process';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { ApplicationChecksums, IChecksumService } from '../common/checksumService.js';

/** Rust owns manifest validation and file reads; Main only starts and bounds the scan. */
export class ChecksumService extends Disposable implements IChecksumService {
	declare public readonly _serviceBrand: undefined;
	private readonly children = new Set<ChildProcess>();
	constructor(private readonly executable: string) {
		super();
		this._register(toDisposable(() => { for (const child of this.children) child.kill('SIGKILL'); }));
	}

	private run(operation: 'scan' | 'checksum', path: string): Promise<string> {
		this.assertNotDisposed();
		return new Promise((resolve, reject) => {
			const child = execFile(this.executable, [operation, path],
				{ encoding: 'utf8', windowsHide: true, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
					this.children.delete(child);
					if (error) reject(error); else resolve(stdout);
				});
			this.children.add(child);
		});
	}

	async checksum(resource: URI): Promise<string> {
		if (resource.scheme !== Schemas.file) throw new TypeError('Checksums require a local file resource');
		const value = await this.run('checksum', resource.fsPath);
		if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('Invalid Rust checksum result');
		return value;
	}

	async scan(applicationRoot: string): Promise<ApplicationChecksums> {
		const proof: unknown = JSON.parse(await this.run('scan', applicationRoot));
		if (!Array.isArray(proof)) throw new TypeError('Invalid Rust integrity result');
		return {
			isBuilt: true, proof: proof.map((entry: unknown) => {
				if (!entry || typeof entry !== 'object' || !('path' in entry) || typeof entry.path !== 'string'
					|| !/^(dist|resources)\//u.test(entry.path) || entry.path.includes('\\') || entry.path.includes('\0') || entry.path.includes(':')
					|| entry.path.split('/').some(part => !part || part === '.' || part === '..')
					|| !('expected' in entry) || typeof entry.expected !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.expected)
					|| !('actual' in entry) || !(entry.actual === null || typeof entry.actual === 'string' && /^[a-f0-9]{64}$/u.test(entry.actual))) {
					throw new TypeError('Invalid Rust integrity proof');
				}
				return { uri: URI.joinPath(URI.file(applicationRoot), entry.path).toJSON(), expected: entry.expected, actual: entry.actual };
			})
		};
	}
}

/** The host binds the immutable installation root; renderer input cannot select files. */
export function checksumChannel(applicationRoot: string, isBuilt: boolean, service: ChecksumService): IServerChannel {
	let result: Promise<ApplicationChecksums> | undefined;
	return {
		async call<T>(_context: string, command: string, argument?: unknown): Promise<T> {
			if (command !== 'getApplicationChecksums' || argument !== undefined) throw new TypeError('Invalid application checksum read');
			result ??= isBuilt ? service.scan(applicationRoot) : Promise.resolve({ isBuilt: false, proof: [] });
			return await result as T;
		},
		listen<T>(): never { throw new TypeError('Application checksums have no subscription'); }
	};
}
