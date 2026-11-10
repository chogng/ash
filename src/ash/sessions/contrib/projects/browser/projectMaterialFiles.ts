import { raceCancellationError, TaskQueue } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import { projectMaterialFilesKey, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';

/** Material IDs identify immutable remote uploads. Publish each copy once, even if two windows fetch it. */
export class ProjectMaterialFiles extends AbstractDisposable {
	private readonly queue = new TaskQueue();
	private readonly pending = new Map<string, Promise<URI>>();
	private readonly controller = new AbortController();

	constructor(
		private readonly files: IFileService,
		private readonly root: URI,
		private readonly projectKey: string,
	) { super(); }

	async ensure(file: { readonly id: string; readonly name: string; }, download: ((signal: AbortSignal) => Promise<Blob>) | undefined): Promise<URI> {
		const signal = this.controller.signal;
		signal.throwIfAborted();
		// Leave room for the disk provider's atomic write suffix and preserve the file's editor type.
		const extension = /\.[a-z0-9]{1,16}$/iu.exec(file.name)?.[0] ?? '';
		const name = isValidBasename(file.name, true) && new TextEncoder().encode(file.name).length <= 200 ? file.name : `file${extension}`;
		const target = URI.from({
			scheme: projectMaterialFilesScheme,
			authority: projectMaterialFilesKey(this.root.fsPath),
			path: `/${projectMaterialFilesKey(this.projectKey)}/${projectMaterialFilesKey(file.id)}/${name}`,
		});
		const exists = await this.isFile(target);
		signal.throwIfAborted();
		if (exists) return target;

		const key = target.toString();
		const pending = this.pending.get(key);
		if (pending) return pending;
		if (!download) throw new Error(localize('projects.localFileOffline', 'This project file is unavailable offline.'));

		const operation = this.queue.schedule(async () => {
			// Another window may have published the copy while this download was queued.
			const alreadySaved = await this.isFile(target);
			signal.throwIfAborted();
			if (alreadySaved) return target;
			const blob = await raceCancellationError(download(signal), signal);
			const bytes = new Uint8Array(await blob.arrayBuffer());
			signal.throwIfAborted();
			try {
				await this.files.writeFileBytes(target, bytes);
			} catch (error) {
				signal.throwIfAborted();
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileExists || !await this.isFile(target)) throw error;
			}
			signal.throwIfAborted();
			return target;
		}).finally(() => { this.pending.delete(key); });
		this.pending.set(key, operation);
		return operation;
	}

	protected override disposeCore(): void {
		this.controller.abort(new CancellationError());
		this.queue.clearPending();
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
