import { raceCancellationError, TaskQueue } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { extname } from '../../../../base/common/path.js';
import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import { projectMaterialFilesKey, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';
import type { ProjectMaterial } from '../../../../platform/projects/common/projectService.js';
import type { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

export function isPreviewableProjectFile(name: string): boolean {
	return extname(name).toLowerCase() === '.pdf' || getMediaOrTextMime(name)?.startsWith('image/') === true;
}

export function openProjectFile(editors: IEditorService, resource: URI, readOnly: boolean): Promise<void> {
	if (isPreviewableProjectFile(resource.path)) {
		return editors.openEditor({ resource, showBreadcrumbs: false, ...(getMediaOrTextMime(resource.path)?.startsWith('image/') ? { readOnly: true } : {}) }, {}, 'modalGroup');
	}
	return editors.openEditor({ resource, ...(readOnly && { readOnly, showBreadcrumbs: false }) });
}

export function projectMaterialId(material: ProjectMaterial): string {
	if (material.kind === 'text') return `text:${material.id}`;
	const resource = material.resource.toString();
	// Include the import size to distinguish previews from legacy path-only copies.
	return material.kind === 'file' ? JSON.stringify([resource, material.sizeBytes]) : resource;
}

export function projectMaterialFile(material: Extract<ProjectMaterial, { kind: 'file'; }>): { id: string; name: string; } {
	// The displayed project label can change independently of the source and its managed copy.
	return { id: projectMaterialId(material), name: basename(material.resource) || material.name };
}

export async function resolveProjectFileReference(files: IFileService, copies: ProjectMaterialFiles | undefined,
	material: Extract<ProjectMaterial, { kind: 'file'; }>, isCurrent: () => boolean): Promise<URI> {
	const file = projectMaterialFile(material);
	if (!copies || !isPreviewableProjectFile(file.name)) return material.resource;
	const stat = await files.stat(material.resource).catch(() => undefined);
	if (stat?.kind === FileKind.File) return material.resource;
	if (!isCurrent()) throw new CancellationError();
	return copies.ensure(file, undefined);
}

/** Publish each local copy once so a repeat download cannot overwrite local annotations. */
export class ProjectMaterialFiles extends AbstractDisposable {
	private readonly queue = new TaskQueue();
	private readonly pending = new Map<string, Promise<URI>>();
	private readonly removing = new Set<string>();
	private readonly controller = new AbortController();

	constructor(
		private readonly files: IFileService,
		private readonly root: URI,
		private readonly projectKey: string,
	) { super(); }

	async ensure(file: { readonly id: string; readonly name: string; }, download: ((signal: AbortSignal) => Promise<Blob>) | undefined): Promise<URI> {
		const signal = this.controller.signal;
		signal.throwIfAborted();
		const target = this.resource(file);
		const key = target.toString();
		const exists = await this.isFile(target);
		signal.throwIfAborted();
		if (this.removing.has(key)) throw new CancellationError();
		if (exists) return target;

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
			if (this.removing.has(key)) throw new CancellationError();
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

	async remove(file: { readonly id: string; readonly name: string; }, purge: (resource: URI) => Promise<void>): Promise<void> {
		const target = this.resource(file);
		const key = target.toString();
		this.removing.add(key);
		try {
			// A download that already reached the provider may still publish its bytes.
			await this.pending.get(key)?.catch(() => undefined);
			await purge(target);
			await this.files.delete(target, 'ignore', 'fileOrEmptyDirectory');
		} finally {
			this.removing.delete(key);
		}
	}

	public resource(file: { readonly id: string; readonly name: string; }): URI {
		// Leave room for the disk provider's atomic write suffix and preserve the file's editor type.
		const extension = /\.[a-z0-9]{1,16}$/iu.exec(file.name)?.[0] ?? '';
		const name = isValidBasename(file.name, true) && new TextEncoder().encode(file.name).length <= 200 ? file.name : `file${extension}`;
		return URI.from({
			scheme: projectMaterialFilesScheme,
			authority: projectMaterialFilesKey(this.root.fsPath),
			path: `/${projectMaterialFilesKey(this.projectKey)}/${projectMaterialFilesKey(file.id)}/${name}`,
		});
	}

	public localResource(resource: URI): URI { return URI.joinPath(this.root, resource.path); }

	public async existing(file: { readonly id: string; readonly name: string; }): Promise<URI | undefined> {
		const resource = this.resource(file);
		return await this.isFile(resource) ? resource : undefined;
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
