import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IConfigurationResourceService } from '../../../../platform/configuration/common/configurationResourceService.js';
import { ConfigurationResourceRevisionConflictError } from '../../../../platform/configuration/common/configurationResourceService.js';
import type { IFileSystemProvider } from '../../../../platform/files/common/fileSystemProviderService.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, FileRevisionConflictError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../../../../platform/files/common/files.js';
import { SettingsFileSystemScheme, UserSettingsResource } from '../../../services/preferences/common/preferencesEditorInput.js';

/** Exposes the editable current-profile settings source through one virtual scheme. */
export class SettingsFileSystemProvider extends Disposable implements IFileSystemProvider {
	public static readonly scheme = SettingsFileSystemScheme;

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
		return fileStat(resource, encodedSize(content.content));
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return Promise.reject(new FileOperationNotSupportedError(resource, 'readDirectory'));
	}

	public async readFile(resource: URI): Promise<IFileContent> {
		if (isEqualResource(resource, UserSettingsResource)) {
			const snapshot = await this.configurationResourceService.read();
			return Object.freeze({ resource, content: snapshot.source, revision: userSettingsRevision(snapshot.revision) });
		}
		throw new FileNotFoundError(resource);
	}

	public async readFileBytes(resource: URI): Promise<IFileBytes> {
		const content = await this.readFile(resource);
		return Object.freeze({ resource, bytes: VSBuffer.fromString(content.content).buffer, revision: content.revision });
	}

	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		if (!isEqualResource(request.resource, UserSettingsResource)) {
			throw new FileOperationNotSupportedError(request.resource, 'writeFile');
		}
		const current = await this.configurationResourceService.read();
		const expectedRevision = request.expectedRevision === undefined
			? current.revision
			: parseUserSettingsRevision(request.resource, request.expectedRevision);
		let saved;
		try {
			saved = await this.configurationResourceService.write(request.content, expectedRevision);
		} catch (error) {
			if (error instanceof ConfigurationResourceRevisionConflictError) throw new FileRevisionConflictError(request.resource);
			throw error;
		}
		return Object.freeze({
			stat: fileStat(request.resource, encodedSize(saved.source)),
			revision: userSettingsRevision(saved.revision),
		});
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		if (!isEqualResource(resource, UserSettingsResource)) throw new FileOperationNotSupportedError(resource, 'createFile');
		if (existing === 'error') throw new Error(`File already exists: ${resource.toString()}`);
		return this.stat(resource);
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
