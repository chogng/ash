import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import type { IFileSystemProvider } from '../../../../../platform/files/common/files.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { BrowserTextModelService } from '../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import type { TextResourceChangeEvent, TextResourceContent, TextResourceResolveRequest, TextResourceSaveRequest, ITextResourceStore } from '../../../../services/textmodelResolver/common/textResourceStore.js';
import { FileKind, FileNotFoundError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior } from '../../../../../platform/files/common/files.js';
import { BulkEditService } from '../../browser/bulkEditService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IDialogService, IConfirmationDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';

export class TestEditorService implements IEditorService {
	public readonly onDidActiveEditorChange = Event.None;
	public readonly onDidVisibleEditorsChange = Event.None;
	public readonly activeEditor = undefined;
	public readonly visibleEditors = [];
	public readonly opened: IResourceEditorInput[] = [];
	public async openEditor(input: IResourceEditorInput): Promise<void> {
		this.opened.push(input);
	}
	public focusActiveEditor(): void { }
}

export class TestDialogService implements IDialogService {
	public readonly onWillShowDialog = Event.None;
	public readonly onDidShowDialog = Event.None;
	public confirmed = true;
	public readonly confirmations: IConfirmationDialogOptions[] = [];
	public readonly errors: string[] = [];
	public async confirm(options: IConfirmationDialogOptions) { this.confirmations.push(options); return { confirmed: this.confirmed }; }
	public async showMessage(): Promise<void> { }
	public async info(): Promise<void> { }
	public async warn(): Promise<void> { }
	public async error(message: string): Promise<void> { this.errors.push(message); }
	public async prompt<T>(): Promise<{ result?: T; }> { return {}; }
	public async input() { return { confirmed: false }; }
	public async about(): Promise<void> { }
}

export class BulkEditTestServices extends Disposable {
	public readonly store: MemoryResourceStore;
	public readonly models: BrowserTextModelService;
	public readonly workingCopies = this._register(new BrowserWorkingCopyService());
	public readonly files: MemoryFileService;
	public readonly service: BulkEditService;
	public readonly configuration = this._register(new InMemoryConfigurationService());
	public readonly dialogs = new TestDialogService();
	constructor(resources: readonly (readonly [URI, string])[]) {
		super();
		this.store = this._register(new MemoryResourceStore(resources));
		this.models = this._register(new BrowserTextModelService(this.store));
		this.files = new MemoryFileService(resources);
		this.service = this._register(new BulkEditService(this.models, this.workingCopies, this._register(createTestFileService(this.files)), this.configuration, this.dialogs));
	}
}

export class MemoryResourceStore implements ITextResourceStore {
	public failNextSave: Error | undefined;
	private readonly changes = new Emitter<TextResourceChangeEvent>();
	readonly onDidChange = this.changes.event;
	readonly saved: string[] = [];
	private readonly resources = new Map<string, { text: string; revision: number; }>();

	constructor(resources: readonly (readonly [URI, string])[]) {
		for (const [resource, text] of resources) this.resources.set(resource.toString(), { text, revision: 1 });
	}

	text(resource: URI): string {
		return this.require(resource).text;
	}

	async resolve(request: TextResourceResolveRequest): Promise<TextResourceContent> {
		const entry = this.resources.get(request.resource.toString());
		if (!entry && request.bootstrapText !== undefined) return { resource: request.resource, text: request.bootstrapText, revision: undefined };
		if (!entry) throw new Error(`Unknown resource ${request.resource.toString()}`);
		return { resource: request.resource, text: entry.text, revision: String(entry.revision) };
	}

	async save(request: TextResourceSaveRequest): Promise<{ readonly revision: string; }> {
		if (this.failNextSave) {
			const error = this.failNextSave;
			this.failNextSave = undefined;
			throw error;
		}
		let entry = this.resources.get(request.resource.toString());
		if (!entry) {
			entry = { text: "", revision: 0 };
			this.resources.set(request.resource.toString(), entry);
		}
		entry.text = request.text;
		entry.revision += 1;
		this.saved.push(request.resource.toString());
		return { revision: String(entry.revision) };
	}

	dispose(): void {
		this.changes.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	private require(resource: URI): { text: string; revision: number; } {
		const entry = this.resources.get(resource.toString());
		if (!entry) throw new Error(`Unknown resource ${resource.toString()}`);
		return entry;
	}
}

export class MemoryFileService implements IFileSystemProvider {
	readonly onDidChangeFiles = Event.None;
	private readonly resources = new Map<string, string>();
	failRename = false;

	constructor(resources: readonly (readonly [URI, string])[]) {
		for (const [resource, text] of resources) this.resources.set(resource.toString(), text);
	}

	has(resource: URI): boolean { return this.resources.has(resource.toString()); }
	text(resource: URI): string { const text = this.resources.get(resource.toString()); if (text === undefined) throw new Error(`Unknown resource ${resource.toString()}`); return text; }
	async stat(resource: URI) { if (!this.has(resource)) throw new FileNotFoundError(resource); return { resource, kind: FileKind.File, sizeBytes: this.text(resource).length, readonly: false, modifiedAtMillis: undefined }; }
	async readDirectory(): Promise<readonly never[]> { return []; }
	async readFile(resource: URI) { return { resource, bytes: new TextEncoder().encode(this.text(resource)), revision: this.text(resource) }; }
	async writeFile(request: { readonly resource: URI; readonly content: string; }) { this.resources.set(request.resource.toString(), request.content); return { stat: await this.stat(request.resource), revision: request.content }; }
	async writeFileBytes(resource: URI, bytes: Uint8Array) { this.resources.set(resource.toString(), new TextDecoder().decode(bytes)); return { stat: await this.stat(resource), revision: 'bytes' }; }
	async createFile(resource: URI, existing: FileExistingTargetBehavior) {
		if (this.has(resource)) {
			if (existing === "error") throw new Error("FileSystemOperationFailed");
			if (existing === "ignore") return this.stat(resource);
		}
		this.resources.set(resource.toString(), "");
		return this.stat(resource);
	}
	async createDirectory(): Promise<never> { throw new Error('Workspace edit tests do not create directories'); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
	async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		if (this.failRename) throw new Error("injected rename failure");
		const sourceText = this.text(source);
		if (this.has(target)) {
			if (existing === "error") throw new Error("FileSystemOperationFailed");
			if (existing === "ignore") return;
		}
		this.resources.delete(source.toString());
		this.resources.set(target.toString(), sourceText);
	}
	async delete(resource: URI, missing: FileMissingTargetBehavior, _mode: FileDeleteMode): Promise<void> {
		if (!this.resources.delete(resource.toString()) && missing === "error") throw new Error("FileSystemOperationFailed");
	}
}
