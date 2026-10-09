import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IConfigurationResourceService } from '../../../../platform/configuration/common/configurationResourceService.js';
import { ConfigurationResourceRevisionConflictError } from '../../../../platform/configuration/common/configurationResourceService.js';
import type { IFileSystemProvider } from '../../../../platform/files/common/files.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, FileRevisionConflictError, FileSystemProviderCapabilities, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileEntry, type IFileStat, type IFileWriteOptions, type IFileWriteResult, type IWatchOptions } from '../../../../platform/files/common/files.js';
import { SettingsFileSystemScheme, UserSettingsResource } from '../../../services/preferences/common/settingsEditorInput.js';

/** Exposes the editable current-profile settings source through one virtual scheme. */
export class SettingsFileSystemProvider extends Disposable implements IFileSystemProvider {
	public static readonly scheme = SettingsFileSystemScheme;
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;

	private readonly changeEmitter = this._register(new Emitter<IFileChangeEvent>());

	public readonly onDidChangeFiles = this.changeEmitter.event;

	constructor(
		private readonly configurationResourceService: IConfigurationResourceService,
	) {
		super();
		this._register(configurationResourceService.onDidChangeResource(() => {
			this.changeEmitter.fire(Object.freeze({ resources: Object.freeze([UserSettingsResource]) }));
		}));
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const content = await this.readFile(resource);
		return fileStat(resource, content.bytes.byteLength);
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'readDirectory'));
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		if (!isEqualResource(resource, UserSettingsResource)) throw new FileNotFoundError(resource);
		const snapshot = await this.configurationResourceService.read();
		return Object.freeze({ resource, bytes: VSBuffer.fromString(snapshot.source).buffer, revision: userSettingsRevision(snapshot.revision) });
	}

	public watch(resource: URI, _options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		if (!isEqualResource(resource, UserSettingsResource)) throw new FileNotFoundError(resource);
		// Configuration owns this virtual resource and publishes its changes independently of watches.
		return Disposable.None;
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!isEqualResource(resource, UserSettingsResource)) {
			throw new FileOperationNotSupportedError(resource, 'writeFile');
		}
		if (!options.overwrite) throw new Error(`File already exists: ${resource.toString()}`);
		const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		const current = await this.configurationResourceService.read();
		const expectedRevision = options.expectedRevision === undefined
			? current.revision
			: parseUserSettingsRevision(resource, options.expectedRevision);
		let saved;
		try {
			saved = await this.configurationResourceService.write(content, expectedRevision);
		} catch (error) {
			if (error instanceof ConfigurationResourceRevisionConflictError) throw new FileRevisionConflictError(resource);
			throw error;
		}
		return Object.freeze({
			stat: fileStat(resource, encodedSize(saved.source)),
			revision: userSettingsRevision(saved.revision),
		});
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		if (!isEqualResource(resource, UserSettingsResource)) throw new FileOperationNotSupportedError(resource, 'createFile');
		if (existing === 'error') throw new Error(`File already exists: ${resource.toString()}`);
		return this.stat(resource);
	}

	public createDirectory(resource: URI): Promise<IFileStat> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'createDirectory'));
	}

	public copy(source: URI, _target: URI): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(source, 'copy'));
	}

	public rename(source: URI, _target: URI, _existing: FileExistingTargetBehavior): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(source, 'rename'));
	}

	public delete(resource: URI, _missing: FileMissingTargetBehavior, _mode: FileDeleteMode): Promise<void> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'delete'));
	}
}

function fileStat(resource: URI, sizeBytes: number): IFileStat {
	return Object.freeze({ resource, kind: FileKind.File, sizeBytes, readonly: false, modifiedAtMillis: undefined });
}

function encodedSize(source: string): number {
	return VSBuffer.fromString(source).byteLength;
}

function userSettingsRevision(revision: number): string {
	return `settings:${revision}`;
}

function parseUserSettingsRevision(resource: URI, revision: string): number {
	const match = /^settings:(\d+)$/u.exec(revision);
	if (!match) throw new FileRevisionConflictError(resource);
	const value = Number(match[1]);
	if (!Number.isSafeInteger(value)) throw new FileRevisionConflictError(resource);
	return value;
}

function isEqualResource(left: URI, right: URI): boolean {
	return left.toString() === right.toString();
}
