import '../../../../../editor/test/browser/testEditorDom.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestEditorService } from './bulkEditTestServices.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event as EventUtils, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { BulkFileOperations } from '../../browser/preview/bulkEditPreview.js';
import { ConflictDetector } from '../../browser/conflicts.js';
import { BulkEditPane } from '../../browser/preview/bulkEditPane.js';
import { BulkEditPreviewContribution } from '../../browser/preview/bulkEdit.contribution.js';
import { registerWindow } from '../../../../../base/browser/window.js';
import { IFileTextModelService, ITextModelResourceService, type ITextModelSaveParticipant, type ITextModelSaveCompletionParticipant, type TextModelReference } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { SaveReason } from '../../../../common/editor.js';
import { type LanguageWorkspaceEdit } from "../../../../../editor/common/languages.js";
import { FileKind, FileNotFoundError, IFileService } from "../../../../../platform/files/common/files.js";
import { IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { ResourceFileEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BulkEditService } from '../../browser/bulkEditService.js';
import { IBulkEditService, ResourceEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test("bulk edit preview follows ordered create and text operations without mutating files", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const existing = URI.file("C:\\workspace\\existing.ts");
	const created = URI.file("C:\\workspace\\created.ts");
	using files = new PreviewFileService([[existing, "alpha"]]);
	using models = new PreviewTextModelService([[existing, "alpha"]], [existing]);
	const edit: LanguageWorkspaceEdit = {
		entries: [
			{ kind: "create", resource: created, existing: "error", contents: 'seed' },
			{ kind: "textDocument", resource: created, expectedText: "seed", edits: [{ range: new Range(1, 5, 1, 5), text: "hello" }] },
			{ kind: "textDocument", resource: existing, expectedText: "alpha", edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), text: "omega" }] },
			{ kind: "textDocument", resource: existing, expectedText: "omega", edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] },
		],
	};

	try {
		using preview = await previewEdits(edit, { files, models, workingCopies: emptyWorkingCopies() }, new AbortController().signal);

		assert.equal(preview.canApply, true);
		assert.equal(preview.entries.every(entry => entry.error === undefined), true);
		assert.equal(preview.entries[1]?.before, "seed");
		assert.equal(preview.entries[1]?.after, "seedhello");
		assert.equal(preview.entries[2]?.before, "alpha");
		assert.equal(preview.entries[2]?.after, "omega");
		assert.equal(preview.entries[3]?.before, "omega");
		assert.equal(preview.entries[3]?.after, "omega!");
		assert.equal(files.read(existing), "alpha");
		assert.equal(files.has(created), false);
	} finally {
		installedGlobals.dispose();
		browser.window.close();
	}
});

test('bulk edit preview reports invalid ranges without clamping or mutating the model', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	const resource = URI.file('/workspace/range.ts');
	using files = new PreviewFileService([[resource, 'abc']]);
	using models = new PreviewTextModelService([[resource, 'abc']], [resource]);
	try {
		using preview = await previewEdits({ entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(2, 1, 2, 2), text: 'invalid' }] }] }, { files, models, workingCopies: emptyWorkingCopies() }, new AbortController().signal);
		assert.deepEqual({ canApply: preview.canApply, error: preview.entries[0]?.error, text: models.getModel(resource)?.getText() }, { canApply: false, error: 'The edit range is outside the document.', text: 'abc' });
	} finally {
		globals.dispose();
		browser.window.close();
	}
});

test('conflict detection covers both rename resources, model mutations and disposal', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	const source = URI.file('/workspace/source.ts');
	const target = URI.file('/workspace/target.ts');
	const text = URI.file('/workspace/text.ts');
	using files = new PreviewFileService([[source, 'source'], [text, 'text']]);
	using models = new PreviewTextModelService([[text, 'text']], [text]);
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(files));
	services.registerInstance(IFileTextModelService, models);
	try {
		using reference = await models.acquire({ resource: text });
		using detector = services.createInstance(ConflictDetector, [new ResourceFileEdit(source, target), new ResourceTextEdit(text, { range: new Range(1, 1, 1, 1), text: 'new' })]);
		files.notify(URI.file('/workspace/unrelated.ts'));
		assert.equal(detector.hasConflicts(), false);
		files.notify(target);
		reference.model.setValue('changed');
		assert.deepEqual(detector.list(), [target, text]);
		detector.dispose();
		files.notify(source);
		assert.deepEqual(detector.list(), [target, text]);
	} finally {
		globals.dispose();
		browser.window.close();
	}
});

for (const outcome of ['accept', 'conflict', 'dispose'] as const) {
	test(`bulk edit contribution ${outcome} connects the registered service, selection and conflict lifecycle`, async () => {
		const browser = new JSDOM('<!doctype html><body></body>');
		const globals = installDomGlobals(browser);
		const resource = URI.file('/workspace/preview.ts');
		using files = new PreviewFileService([[resource, 'ab']]);
		using models = new PreviewTextModelService([[resource, 'ab']], [resource]);
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerSingleton(IFileService, () => createTestFileService(files));
		services.registerInstance(IFileTextModelService, models);
		services.registerInstance(ITextModelResourceService, models);
		services.registerInstance(IConfigurationService, configuration);
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorService, new TestEditorService());
		services.registerInstance(IWorkingCopyService, emptyWorkingCopies());
		services.registerInstance(IDialogService, {
			onWillShowDialog: EventUtils.None, onDidShowDialog: EventUtils.None,
			confirm: async () => ({ confirmed: true }),
			showMessage: async () => { }, info: async () => { }, warn: async () => { }, error: async () => { },
			prompt: async () => ({}), input: async () => ({ confirmed: false }), about: async () => { },
		});
		try {
			using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: 'Refactor Preview' });
			browser.window.document.body.append(pane.element);
			pane.setVisible(true);
			services.registerInstance(IViewsService, { openView: async () => pane, getViewWithId: () => pane, focusView: async () => { pane.focus(); return true; } } as unknown as IViewsService);
			using bulkEdits = services.createInstance(BulkEditService);
			services.registerInstance(IBulkEditService, bulkEdits);
			using contribution = services.createInstance(BulkEditPreviewContribution);
			const ready = new Promise<void>(resolve => {
				const observer = new browser.window.MutationObserver(() => {
					if (pane.hasInput) { observer.disconnect(); resolve(); }
				});
				observer.observe(pane.element, { childList: true, subtree: true });
			});
			const edits = [{ range: new Range(1, 1, 1, 2), text: 'A' }, { range: new Range(1, 2, 1, 3), text: 'B' }];
			const pending = bulkEdits.apply({ entries: [{ kind: 'textDocument', resource, expectedText: 'ab', edits }] }, { showPreview: true });
			await ready;
			const provider = AccessibleViewRegistry.getImplementations().find(provider => provider.name === 'bulk-edit-preview-help')!.getProvider(services);
			assert.match(provider!.provideContent(), /Press Escape to cancel/);
			provider!.dispose();
			assert.ok(AccessibleViewRegistry.getImplementations().some(provider => provider.type === AccessibleViewType.View && provider.name === 'bulk-edit-preview-view'));
			if (outcome === 'accept') {
				pane.element.querySelector<HTMLInputElement>('input[data-text-edit-index="0"]')!.click();
				pane.accept();
				assert.equal((await pending).isApplied, true);
				assert.equal(models.getModel(resource)!.getText(), 'aB');
			} else {
				if (outcome === 'conflict') {
					models.getModel(resource)!.setValue('changed');
					assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-apply')!.disabled, true);
					pane.accept();
					pane.discard();
				} else contribution.dispose();
				assert.deepEqual({ applied: (await pending).isApplied, text: models.getModel(resource)!.getText() }, { applied: false, text: outcome === 'conflict' ? 'changed' : 'ab' });
			}
		} finally {
			globals.dispose();
			browser.window.close();
		}
	});
}

class PreviewTextModelService extends Disposable implements IFileTextModelService {
	hasPendingSaveRecovery(): boolean { return false; }
	async waitForSaveRecovery(): Promise<void> { }
	private readonly participants = new Set<ITextModelSaveParticipant>();
	private readonly completions = new Set<ITextModelSaveCompletionParticipant>();
	addSaveCompletionParticipant(participant: ITextModelSaveCompletionParticipant) {
		this.completions.add(participant);
		return toDisposable(() => this.completions.delete(participant));
	}
	addSaveParticipant(participant: ITextModelSaveParticipant) {
		this.participants.add(participant);
		return toDisposable(() => this.participants.delete(participant));
	}
	readonly references: TextModelReference[] = [];
	private readonly resources: ReadonlyMap<string, string>;
	private readonly persistentResources: ReadonlySet<string>;
	private readonly persistentModels = new Map<string, TextModel>();
	private readonly modelAdded = this._register(new Emitter<TextModel>());
	readonly onModelAdded = this.modelAdded.event;
	readonly onModelRemoved = EventUtils.None;
	readonly onModelLanguageChanged = EventUtils.None;

	constructor(resources: readonly (readonly [URI, string])[], persistentResources: readonly URI[] = []) {
		super();
		this.resources = new Map(resources.map(([resource, text]) => [resource.toString(), text]));
		this.persistentResources = new Set(persistentResources.map(resource => resource.toString()));
		this._register(toDisposable(() => {
			for (const model of this.persistentModels.values()) model.dispose();
			this.persistentModels.clear();
		}));
	}

	async acquire(input: { readonly resource: URI; readonly initialText?: string; }): Promise<TextModelReference> {
		const key = input.resource.toString();
		const existing = this.persistentModels.get(key);
		const model = existing ?? new TextModel(input.initialText ?? this.resources.get(key) ?? "", { resource: input.resource });
		const persistent = this.persistentResources.has(key);
		if (persistent) this.persistentModels.set(key, model);
		if (!existing && persistent) this.modelAdded.fire(model);
		const emptyEvent = () => toDisposable(() => undefined);
		const reference: TextModelReference = {
			resource: input.resource,
			model,
			isDirty: false,
			onDidChangeDirty: emptyEvent,
			hasExternalChange: false,
			onDidChangeExternalChange: emptyEvent,
			save: async (signal, options) => {
				if (!options?.skipSaveParticipants) {
					for (const participant of this.participants) await participant.participate(model, options?.reason ?? SaveReason.EXPLICIT, signal);
				}
				for (const participant of this.completions) {
					const complete = await participant.prepare(model, signal, { retry: false, acknowledge: () => { } });
					await complete?.(model.getText());
				}
			},
			revert: async () => undefined,
			saveAs: async () => { throw new Error('Preview must not save copies'); },
			dispose: () => { if (!persistent) model.dispose(); },
			[Symbol.dispose]() { if (!persistent) model.dispose(); },
		};
		this.references.push(reference);
		return reference;
	}

	getModel(resource: URI): TextModel | null {
		return this.persistentModels.get(resource.toString()) ?? null;
	}
	getModels(): readonly TextModel[] {
		return [...this.persistentModels.values()];
	}
	async refresh(): Promise<void> { }
}

class PreviewFileService extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	private readonly changeEmitter = this._register(new Emitter<{ readonly resources: readonly URI[] | undefined; }>());
	readonly onDidChangeFiles = this.changeEmitter.event;
	private readonly resources = new Map<string, string>();

	constructor(resources: readonly (readonly [URI, string])[]) {
		super();
		for (const [resource, text] of resources) this.resources.set(resource.toString(), text);
	}

	notify(resource: URI): void { this.changeEmitter.fire({ resources: [resource] }); }

	has(resource: URI): boolean { return this.resources.has(resource.toString()); }
	read(resource: URI): string { return this.resources.get(resource.toString()) ?? ""; }
	async stat(resource: URI) {
		if (!this.has(resource)) throw new FileNotFoundError(resource);
		return { resource, kind: FileKind.File, sizeBytes: this.read(resource).length, readonly: false, modifiedAtMillis: undefined };
	}
	async readDirectory(): Promise<readonly never[]> { return []; }
	async readFile(resource: URI) {
		if (!this.has(resource)) throw new FileNotFoundError(resource);
		const content = this.read(resource);
		return { resource, bytes: new TextEncoder().encode(content), revision: '1' };
	}
	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { throw new Error("Preview must not write files"); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		throw new Error("Preview must not write files");
	}
	async createFile(): Promise<never> { throw new Error("Preview must not create files"); }
	async createDirectory(): Promise<never> { throw new Error("Preview must not create directories"); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
	async rename(): Promise<never> { throw new Error("Preview must not rename files"); }
	async delete(): Promise<never> { throw new Error("Preview must not delete files"); }
}

function emptyWorkingCopies(): IWorkingCopyService {
	const emptyEvent = () => toDisposable(() => undefined);
	return {
		onDidRegister: emptyEvent,
		onDidUnregister: emptyEvent,
		onDidChangeDirty: emptyEvent,
		hasDirtyWorkingCopies: false,
		register: () => toDisposable(() => undefined),
		get: () => [],
		getAll: () => [],
		dispose() { },
		[Symbol.dispose]() { },
	};
}

function installDomGlobals(browser: JSDOM) {
	// Keep the main realm's globals while the pane runs in a registered second window.
	return registerWindow(browser.window as unknown as Window);
}

async function previewEdits(edit: LanguageWorkspaceEdit, dependencies: { files: PreviewFileService; models: PreviewTextModelService; workingCopies: IWorkingCopyService; }, signal: AbortSignal): Promise<BulkFileOperations> {
	using services = new InstantiationService();
	services.registerSingleton(IFileService, () => createTestFileService(dependencies.files));
	services.registerInstance(ITextModelResourceService, dependencies.models);
	services.registerInstance(IFileTextModelService, dependencies.models);
	services.registerInstance(IWorkingCopyService, dependencies.workingCopies);
	return await services.invokeFunction(BulkFileOperations.create, ResourceEdit.convert(edit), signal);
}
