import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import {
	FileKind,
	FileNotFoundError,
	FileOperationNotSupportedError,
	FileRevisionConflictError,
	FileSystemProviderCapabilities,
	IFileService,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileBytes,
	type IFileChangeEvent,
	type IFileEntry,
	type IFileStat,
	type IFileSystemProvider,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from '../../../../platform/files/common/files.js';
import { ITrustedDomainService } from '../common/trustedDomainService.js';
import { TRUSTED_DOMAINS_URI } from './trustedDomains.js';

/** Exposes the service's sole JSONC source through the ordinary editor save path. */
export class TrustedDomainsFileSystemProvider extends Disposable implements IFileSystemProvider {
	readonly capabilities =
		FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly changed = this._register(new Emitter<IFileChangeEvent>());
	readonly onDidChangeFiles = this.changed.event;

	constructor(
		@ITrustedDomainService private readonly domains: ITrustedDomainService,
		@IFileService files: IFileService,
	) {
		super();
		this._register(files.registerProvider(TRUSTED_DOMAINS_URI.scheme, this));
		this._register(
			domains.onDidChangeTrustedDomains(() => this.changed.fire({ resources: [TRUSTED_DOMAINS_URI] })),
		);
	}

	async readFile(resource: URI): Promise<IFileBytes> {
		this.checkResource(resource);
		const content = this.domains.content;
		return { resource, bytes: VSBuffer.fromString(content).buffer, revision: content };
	}

	async stat(resource: URI): Promise<IFileStat> {
		const result = await this.readFile(resource);
		return this.fileStat(result.bytes.byteLength);
	}

	watch(resource: URI, _options: IWatchOptions): IDisposable {
		this.checkResource(resource);
		return Disposable.None;
	}

	async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		this.checkResource(resource);
		if (!options.overwrite || options.unlock || options.writeElevated)
			throw new FileOperationNotSupportedError(resource, 'writeFile');
		const current = this.domains.content;
		if (options.expectedRevision !== undefined && options.expectedRevision !== current)
			throw new FileRevisionConflictError(resource);
		const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		await this.domains.setTrustedDomains(content, current);
		return { stat: this.fileStat(VSBuffer.fromString(content).byteLength), revision: content };
	}

	async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		this.checkResource(resource);
		if (existing === 'error') throw new FileOperationNotSupportedError(resource, 'createFile');
		return this.stat(resource);
	}

	readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'readDirectory'));
	}

	createDirectory(resource: URI): Promise<IFileStat> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'createDirectory'));
	}

	copy(source: URI, _target: URI): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(source, 'copy'));
	}

	rename(source: URI, _target: URI, _existing: FileExistingTargetBehavior): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(source, 'rename'));
	}

	delete(resource: URI, _missing: FileMissingTargetBehavior, _mode: FileDeleteMode): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'delete'));
	}

	private checkResource(resource: URI): void {
		this.assertNotDisposed();
		if (resource.toString() !== TRUSTED_DOMAINS_URI.toString()) throw new FileNotFoundError(resource);
	}

	private fileStat(sizeBytes: number): IFileStat {
		return {
			resource: TRUSTED_DOMAINS_URI,
			kind: FileKind.File,
			sizeBytes,
			readonly: false,
			modifiedAtMillis: undefined,
		};
	}
}
