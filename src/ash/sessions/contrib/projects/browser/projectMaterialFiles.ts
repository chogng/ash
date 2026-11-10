import { TaskQueue } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import { projectMaterialFilesKey, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';

/** Material IDs identify immutable remote uploads. Publish each copy once, even if two windows fetch it. */
export class ProjectMaterialFiles {
	private readonly queue = new TaskQueue();
	private readonly pending = new Map<string, Promise<URI>>();

	constructor(private readonly files: IFileService) { }

	ensure(root: URI, projectKey: string, file: { readonly id: string; readonly name: string; },
		isCurrent: () => boolean, download: (() => Promise<Blob>) | undefined): Promise<URI> {
		// Leave room for the disk provider's atomic write suffix and preserve the file's editor type.
		const extension = /\.[a-z0-9]{1,16}$/iu.exec(file.name)?.[0] ?? '';
		const name = isValidBasename(file.name, true) && new TextEncoder().encode(file.name).length <= 200 ? file.name : `file${extension}`;
		const target = URI.from({
			scheme: projectMaterialFilesScheme,
			authority: projectMaterialFilesKey(root.fsPath),
			path: `/${projectMaterialFilesKey(projectKey)}/${projectMaterialFilesKey(file.id)}/${name}`,
		});
		const key = target.toString();
		const pending = this.pending.get(key);
		if (pending) return pending;
		const operation = this.queue.schedule(async () => {
			if (!isCurrent()) throw new CancellationError();
			if (await this.isFile(target)) return target;
			if (!isCurrent()) throw new CancellationError();
			if (!download) throw new Error(localize('projects.localFileOffline', 'This project file is unavailable offline.'));
			const bytes = new Uint8Array(await (await download()).arrayBuffer());
			if (!isCurrent()) throw new CancellationError();
			try {
				await this.files.writeFileBytes(target, bytes);
			} catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileExists || !await this.isFile(target)) throw error;
			}
			return target;
		}).finally(() => { this.pending.delete(key); });
		this.pending.set(key, operation);
		return operation;
	}

	private async isFile(resource: URI): Promise<boolean> {
		try {
			if ((await this.files.stat(resource)).kind === FileKind.File) return true;
			throw new Error(localize('projects.localFileConflict', 'The project file path is occupied by another item.'));
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound) return false;
			throw error;
		}
	}
}
