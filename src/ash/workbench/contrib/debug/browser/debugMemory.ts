import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	IFileService,
	FileKind,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	FileOperationNotSupportedError,
	type IFileSystemProvider,
	type IFileBytes,
	type IFileContent,
	type IFileStat,
	type IFileWriteOptions,
	type IFileWriteResult,
} from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { IDebugService } from '../common/debug.js';

export function memoryResource(sessionId: string, revision: number, reference: string, offset = 0, count = 256): URI {
	return URI.from({
		scheme: 'debug-memory',
		path: `/${generateUuid()}/memory.hex`,
		query: new URLSearchParams({
			session: sessionId,
			revision: String(revision),
			reference,
			offset: String(offset),
			count: String(count),
		}).toString(),
	});
}

/** Virtual memory files expose exact bytes, with an editable hex codec for text editors. */
export class DebugMemoryFileSystemProvider extends Disposable implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<{ resources: readonly URI[] }>());
	readonly onDidChangeFiles = this.changes.event;
	private readonly watches = this._register(new DisposableMap<object, DisposableStore>());

	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IFileService files: IFileService,
	) {
		super();
		this._register(files.registerProvider('debug-memory', this));
	}

	watch(resource: URI): IDisposable {
		const address = this.address(resource);
		const key = {};
		const lifetime = this.watches.set(key, new DisposableStore());
		lifetime.add(
			address.session.onDidInvalidateMemory(event => {
				if (event.memoryReference === address.reference && event.offset < address.offset + address.count && event.offset + event.count > address.offset)
					this.changes.fire({ resources: [resource] });
			}),
		);
		lifetime.add(address.session.onDidChangeState(() => this.changes.fire({ resources: [resource] })));
		return toDisposable(() => this.watches.deleteAndDispose(key));
	}

	private address(resource: URI) {
		const query = new URLSearchParams(resource.query);
		const id = query.get('session');
		const reference = query.get('reference');
		const offset = Number(query.get('offset'));
		const count = Number(query.get('count'));
		if (
			this.isDisposed ||
			resource.scheme !== 'debug-memory' ||
			!id ||
			!reference ||
			reference.length > 4096 ||
			reference.includes('\0') ||
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(count) ||
			count < 1 ||
			count > 4096
		) {
			throw new FileSystemProviderError(localize('debug.memoryAddressInvalid', 'Invalid debug memory address or byte range.'), FileSystemProviderErrorCode.Unavailable);
		}
		const session = this.debug.getSession(id);
		const revision = Number(query.get('revision'));
		if (!query.has('revision') || !Number.isSafeInteger(revision) || revision !== session?.inspectionRevision || session.state !== 'stopped')
			throw new FileSystemProviderError(localize('debug.memoryExpired', 'This memory view expired. Reopen it from the current paused session.'), FileSystemProviderErrorCode.Unavailable);
		return { session, reference, offset, count };
	}

	async readFile(resource: URI): Promise<IFileBytes> {
		const address = this.address(resource);
		const result = await address.session.readMemory(address.reference, address.offset, address.count);
		this.address(resource);
		if (result.unreadableBytes || result.data.length !== address.count)
			throw new FileSystemProviderError(
				localize('debug.memoryUnreadable', '{0} requested memory bytes are unreadable. Choose a smaller range.', Math.max(result.unreadableBytes, address.count - result.data.length)),
				FileSystemProviderErrorCode.Unavailable,
			);
		return { resource, bytes: result.data, revision: encodeBase64(VSBuffer.wrap(new Uint8Array(result.data))) };
	}

	async readTextFile(resource: URI): Promise<IFileContent> {
		const result = await this.readFile(resource);
		const lines: string[] = [];
		for (let start = 0; start < result.bytes.length; start += 16) lines.push([...result.bytes.slice(start, start + 16)].map(byte => byte.toString(16).padStart(2, '0')).join(' '));
		return { resource, content: lines.join('\n'), revision: result.revision, encoding: 'utf8' };
	}

	async writeTextFile(resource: URI, content: string, _encoding: string, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (content.length > 16384 || !/^\s*(?:[\da-fA-F]{2}(?:\s+|$))*$/.test(content))
			throw new FileSystemProviderError(localize('debug.memoryHexInvalid', 'Enter pairs of hexadecimal digits separated by spaces or newlines.'), FileSystemProviderErrorCode.Unavailable);
		return this.writeFile(
			resource,
			Uint8Array.from(
				content.trim()
					? content
							.trim()
							.split(/\s+/)
							.map(byte => parseInt(byte, 16))
					: [],
			),
			options,
		);
	}

	async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const address = this.address(resource);
		if (!options.overwrite || bytes.length !== address.count || !address.session.capabilities.supportsWriteMemoryRequest)
			throw new FileSystemProviderError(
				localize('debug.memoryWriteInvalid', 'Memory edits must preserve the selected byte count and require adapter write support.'),
				FileSystemProviderErrorCode.NoPermissions,
			);
		if (options.expectedRevision !== undefined && options.expectedRevision !== (await this.readFile(resource)).revision)
			throw new FileSystemProviderError(localize('debug.memoryConflict', 'Memory changed since this view was read. Reopen it before editing.'), FileSystemProviderErrorCode.FileWriteLocked);
		this.address(resource);
		const written = await address.session.writeMemory(address.reference, address.offset, bytes);
		this.address(resource);
		this.changes.fire({ resources: [resource] });
		if (written !== bytes.length)
			throw new FileSystemProviderError(
				localize('debug.memoryPartialWrite', 'The adapter wrote only {0} of {1} bytes. Reopen memory to inspect the result.', written, bytes.length),
				FileSystemProviderErrorCode.Unavailable,
			);
		return {
			stat: this.metadata(resource, address.count, false),
			revision: encodeBase64(VSBuffer.wrap(new Uint8Array(bytes))),
		};
	}

	async stat(resource: URI): Promise<IFileStat> {
		const address = this.address(resource);
		return this.metadata(resource, address.count, !address.session.capabilities.supportsWriteMemoryRequest);
	}
	private metadata(resource: URI, sizeBytes: number, readonly: boolean): IFileStat {
		return { resource, kind: FileKind.File, sizeBytes, readonly, modifiedAtMillis: undefined };
	}
	async readDirectory(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'readDirectory');
	}
	async createFile(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'createFile');
	}
	async createDirectory(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'createDirectory');
	}
	async copy(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'copy');
	}
	async rename(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'rename');
	}
	async delete(resource: URI): Promise<never> {
		throw new FileOperationNotSupportedError(resource, 'delete');
	}
}
