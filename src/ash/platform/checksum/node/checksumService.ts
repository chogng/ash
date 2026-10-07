import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { ApplicationChecksums, IChecksumService } from '../common/checksumService.js';

export class ChecksumService implements IChecksumService {
	declare public readonly _serviceBrand: undefined;

	public async checksum(resource: URI): Promise<string> {
		if (resource.scheme !== Schemas.file) {
			throw new TypeError('Checksums require a local file resource');
		}
		const hash = createHash('sha256');
		for await (const bytes of createReadStream(resource.fsPath)) {
			hash.update(bytes);
		}
		return hash.digest('hex');
	}
}

/** The immutable application root and its published manifest are bound by the desktop host. */
export function checksumChannel(applicationRoot: string, isBuilt: boolean, service: IChecksumService): IServerChannel {
	let result: Promise<ApplicationChecksums> | undefined;
	return {
		async call<T>(_context: string, command: string, argument?: unknown): Promise<T> {
			if (command !== 'getApplicationChecksums' || argument !== undefined) {
				throw new TypeError('Invalid application checksum read');
			}
			result ??= readApplicationChecksums(applicationRoot, isBuilt, service);
			return await result as T;
		},
		listen<T>(): never {
			throw new TypeError('Application checksums have no subscription');
		},
	};
}

async function readApplicationChecksums(applicationRoot: string, isBuilt: boolean, service: IChecksumService): Promise<ApplicationChecksums> {
	if (!isBuilt) {
		return { isBuilt: false, proof: [] };
	}
	const metadata: unknown = JSON.parse(await readFile(join(applicationRoot, 'package.json'), 'utf8'));
	if (!metadata || typeof metadata !== 'object' || !('checksums' in metadata)) {
		throw new TypeError('Packaged application has no checksum manifest');
	}
	const checksums = metadata.checksums;
	if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) {
		throw new TypeError('Invalid application checksum manifest');
	}
	const entries = Object.entries(checksums);
	const required = ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html'];
	if (required.some(path => !Object.hasOwn(checksums, path))) {
		throw new TypeError('Application checksum manifest omits required entrypoints');
	}
	// Validate the whole persisted manifest before accessing any of its paths.
	for (const [path, expected] of entries) {
		const invalidPath = !/^(dist|resources)\//u.test(path) || path.includes('\\') || path.includes('\0')
			|| path.split('/').some(segment => !segment || segment === '.' || segment === '..');
		const invalidChecksum = typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected);
		if (invalidPath || invalidChecksum) {
			throw new TypeError('Invalid application checksum entry');
		}
	}
	const proof: ApplicationChecksums['proof'][number][] = [];
	// A bounded sequential scan avoids opening the full renderer asset set at once.
	for (const [path, expected] of entries) {
		const uri = URI.file(join(applicationRoot, path));
		let actual: string | null = null;
		try {
			actual = await service.checksum(uri);
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
				throw error;
			}
			// A removed published file is a failed comparison, not a successful empty scan.
		}
		proof.push({ uri: uri.toJSON(), expected: expected as string, actual });
	}
	return { isBuilt: true, proof };
}
