import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService, type IQuickInputService as IQuickInputServiceContract, type IQuickPick, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IEditorPart as IEditorPartContract } from "../../../../browser/parts/editor/editorPart.js";
import { ExtensionFileTemplateRegistry } from "../../../extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../extensions/common/extensionService.js";
import { UntitledTextEditorService } from "../../common/untitledTextEditorService.js";
import { BrowserTextModelService } from "../../../textmodelResolver/browser/browserTextModelService.js";
import { ITextModelResourceService } from "../../../textmodelResolver/common/textModelResourceService.js";
import { UntitledTextEditorInput } from "../../common/untitledTextEditorInput.js";
import { UntitledTextEditorWorkingCopyEditorHandler } from "../../common/untitledTextEditorHandler.js";
import { IUntitledTextEditorService } from "../../common/untitledTextEditorService.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { BrowserWorkingCopyService } from "../../../workingCopy/browser/browserWorkingCopyService.js";
import { IWorkingCopyService, type IWorkingCopy } from "../../../workingCopy/common/workingCopyService.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { IEditorPart } = await import("../../../../browser/parts/editor/editorPart.js");
const { NewFileFromTemplateCommandId } = await import("../../../../browser/parts/editor/editorActions.js");
const { NEW_UNTITLED_FILE_COMMAND_ID } = await import("../../../../contrib/files/browser/fileConstants.js");
await import("../../../../contrib/files/browser/fileActions.contribution.js");

suiteTeardown(() => browserEnvironment.window.close());

test("untitled service creates stable virtual editor identities", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const first = service.create();
	const second = service.create({ initialValue: "draft", languageId: "typescript" });

	assert.equal(first.resource.toString(), "untitled:/Untitled-1");
	assert.equal(first.name, "Untitled-1");
	assert.equal(first.initialValue, "");
	assert.equal(second.resource.toString(), "untitled:/Untitled-2");
	assert.equal(second.initialValue, "draft");
	assert.equal(second.getLanguageId(), "typescript");
	assert.equal(service.get(first.resource), first);
	assert.equal(service.get(URI.file("C:\\project\\main.ts")), undefined);
	assert.equal(service.isUntitled(first.resource), true);
	assert.equal(service.isUntitled(URI.file("C:\\project\\main.ts")), false);
});

test("untitled service publishes display-label changes without changing resource identity", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const editor = service.create();
	const changes: string[] = [];
	using listener = service.onDidChangeLabel(value => changes.push(value.name));
	const input = new UntitledTextEditorInput(editor);
	using inputListener = input.onDidChangeLabel(() => changes.push(`input:${input.label}`));

	const renamed = service.rename(editor.resource, "Scratch");
	assert.equal(renamed, editor);
	assert.equal(renamed?.resource.toString(), editor.resource.toString());
	assert.equal(renamed?.name, "Scratch");
	assert.equal(editor.name, "Scratch");
	assert.equal(service.get(editor.resource)?.name, "Scratch");
	assert.deepEqual(changes, ["input:Scratch", "Scratch"]);
	assert.equal(service.rename(URI.file("C:\\project\\main.ts"), "Other"), undefined);
});

test("restored untitled resources are reused and reserve their document numbers", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const resource = URI.parse("untitled:/Untitled-7");
	const restored = service.create({ untitledResource: resource, initialValue: "recovered draft", languageId: "typescript", label: 'Recovered draft' });

	assert.equal(service.create({ untitledResource: resource, initialValue: "stale" }), restored);
	assert.deepEqual({ restored: restored.initialValue, label: restored.name, next: service.create().resource.toString() }, {
		restored: "recovered draft",
		label: 'Recovered draft',
		next: "untitled:/Untitled-8",
	});
	service.reset();
	assert.equal(service.get(resource), undefined);
	assert.equal(service.create().resource.toString(), "untitled:/Untitled-1");
});

test("closing the last working copy releases its untitled identity and shared text", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const editor = await service.resolve();
	const text = editor.textEditorModel!;
	const copy: IWorkingCopy = {
		resource: editor.resource,
		backupKind: "text",
		isDirty: false,
		hasExternalChange: false,
		onDidChangeDirty: Event.None,
		onDidChangeExternalChange: Event.None,
		onDidChangeContent: Event.None,
		backup: () => "",
		restoreBackup: () => {},
		save: async () => {},
		saveAs: async () => {},
		revert: async () => {},
		dispose: () => {},
		[Symbol.dispose]: () => {},
	};
	using first = workingCopies.register(copy);
	using second = workingCopies.register({ ...copy });
	first.dispose();
	assert.equal(service.get(editor.resource), editor);
	assert.equal(text.isDisposed(), false);
	second.dispose();
	assert.equal(service.get(editor.resource), undefined);
	assert.equal(text.isDisposed(), true);
});

test("New Untitled Text Editor opens a compatible text editor input", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using untitled = services.createInstance(UntitledTextEditorService);
	const opened: Array<{ readonly resource: URI; readonly label?: string; readonly initialText?: string }> = [];
	const editorPart = { openEditor: async (input: typeof opened[number]) => { opened.push(input); } } as unknown as IEditorPartContract;
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, editorPart);
	using commands = new CommandService(services);

	await commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);

	assert.equal(opened.length, 1);
	assert.ok(opened[0] instanceof UntitledTextEditorInput);
	assert.equal(opened[0]?.resource.toString(), "untitled:/Untitled-1");
	assert.equal(opened[0]?.label, "Untitled-1");
	assert.equal(opened[0]?.initialText, "");
});

test("New File from Template opens the selected extension template as an untitled editor", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using models = createModels();
	services.registerInstance(ITextModelResourceService, models);
	using untitled = services.createInstance(UntitledTextEditorService);
	using templates = new ExtensionFileTemplateRegistry();
	templates.replace([{
		id: "builtin.typescript.class",
		extensionId: "ash.typescript",
		label: "TypeScript Class",
		languageId: "typescript",
		body: "export class Example {}\n",
		description: "Create a class",
	}]);
	const opened: Array<{ readonly resource: URI; readonly label?: string; readonly initialText?: string; readonly languageId?: string }> = [];
	const editorPart = { openEditor: async (input: typeof opened[number]) => { opened.push(input); } } as unknown as IEditorPartContract;
	const quickInput = new TestQuickInputService();
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, editorPart);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IExtensionService, { fileTemplates: templates } as unknown as IExtensionService);
	using commands = new CommandService(services);

	await commands.executeCommand(NewFileFromTemplateCommandId);
	quickInput.picker?.acceptFirst();
	await Promise.resolve();

	assert.equal(quickInput.picker?.placeholder, "Select a file template");
	assert.equal(quickInput.picker?.items[0]?.label, "TypeScript Class");
	assert.equal(opened.length, 1);
	assert.ok(opened[0] instanceof UntitledTextEditorInput);
	assert.equal(opened[0]?.resource.toString(), "untitled:/Untitled-1");
	assert.equal(opened[0]?.initialText, "export class Example {}\n");
	assert.equal(opened[0]?.languageId, "typescript");
});

test('untitled inputs resolve the shared editable text and publish dirty changes', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	using models = createModels();
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const draft = service.create({ initialValue: 'draft', languageId: 'typescript' });
	const first = new UntitledTextEditorInput(draft);
	const second = new UntitledTextEditorInput(draft);
	const resolved = await Promise.all([first.resolve(), second.resolve()]);
	using reference = await models.acquire(first, new AbortController().signal);
	const dirtyChanges: boolean[] = [];
	using dirtyListener = draft.onDidChangeDirty(() => dirtyChanges.push(draft.isDirty()));

	assert.equal(resolved[0], resolved[1]);
	assert.equal(draft.textEditorModel, reference.model);
	assert.equal(draft.isResolved(), true);
	assert.equal(draft.isReadonly(), false);
	assert.equal(draft.isDirty(), true);
	assert.equal(draft.createSnapshot()?.read(), 'draft');
	await reference.revert(new AbortController().signal);
	assert.deepEqual({ text: reference.model.getText(), dirty: draft.isDirty(), dirtyChanges }, {
		text: '', dirty: false, dirtyChanges: [false],
	});
});

test('the backup handler restores an editable input and keeps its recovered number reserved', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	using models = createModels();
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	services.registerInstance(IUntitledTextEditorService, service);
	const handler = services.createInstance(UntitledTextEditorWorkingCopyEditorHandler);
	const backup = { resource: URI.parse('untitled:/Untitled-7'), kind: 'text' as const, content: 'recovered draft', languageId: 'typescript', label: 'Recovered', updatedAt: 0 };
	const input = handler.createEditor(backup);
	const model = await input.resolve();
	assert.equal(handler.handles({ ...backup, kind: 'structuredDocument' }), false);
	assert.equal(handler.handles({ ...backup, resource: URI.file('/workspace/file.ts') }), false);
	assert.throws(() => handler.createEditor({ ...backup, kind: 'structuredDocument' }), TypeError);
	assert.equal((await handler.createEditor(backup).resolve()), model);
	assert.deepEqual({ text: model.textEditorModel?.getValue(), label: input.label, language: input.languageId, dirty: model.isDirty(), next: service.create().resource.toString() }, {
		text: 'recovered draft', label: 'Recovered', language: 'typescript', dirty: true, next: 'untitled:/Untitled-8',
	});
});

test('disposing a draft releases its shared text reference and removes the service identity', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	using models = createModels();
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const draft = await service.resolve({ initialValue: 'draft' });
	const text = draft.textEditorModel!;
	const released: string[] = [];
	using listener = service.onWillDispose(model => released.push(model.resource.toString()));

	draft.dispose();
	assert.deepEqual({ released, registered: service.get(draft.resource), resolved: draft.isResolved(), textDisposed: text.isDisposed() }, {
		released: ['untitled:/Untitled-1'], registered: undefined, resolved: false, textDisposed: true,
	});
});

test('reset cancels pending draft resolution without retaining a text model', async () => {
	let finishRead: (() => void) | undefined;
	const reading = new Promise<void>(resolve => { finishRead = resolve; });
	using models = new BrowserTextModelService({
		onDidChange: Event.None,
		resolve: async request => {
			await reading;
			return { resource: request.resource, text: request.bootstrapText ?? '', revision: undefined };
		},
		save: async () => ({ revision: undefined }),
	});
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ITextModelResourceService, models);
	using service = services.createInstance(UntitledTextEditorService);
	const draft = service.create({ initialValue: 'draft' });
	const pending = new UntitledTextEditorInput(draft).resolve();
	const cancelled = assert.rejects(pending, /cancelled/u);
	service.reset();
	finishRead!();
	await cancelled;
	assert.deepEqual({ registered: service.get(draft.resource), resolved: draft.isResolved(), text: models.getModel(draft.resource) }, {
		registered: undefined, resolved: false, text: null,
	});
});

function createModels(): BrowserTextModelService {
	return new BrowserTextModelService({
		onDidChange: Event.None,
		resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
		save: async () => ({ revision: undefined }),
	});
}

class TestQuickInputService implements IQuickInputServiceContract {
	picker: TestQuickPick<IQuickPickItem> | undefined;
	async input(): Promise<string | undefined> { return undefined; }

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
		return picker;
	}
}

class TestQuickPick<TItem extends IQuickPickItem> implements IQuickPick<TItem> {
	private readonly acceptEmitter = new Emitter<TItem>();
	private readonly valueEmitter = new Emitter<string>();
	private readonly hideEmitter = new Emitter<void>();

	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidChangeValue = this.valueEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	items: readonly TItem[] = [];
	ariaLabel = '';
	placeholder = "";
	value = "";
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;

	acceptFirst(): void {
		const item = this.items[0];
		if (item) this.acceptEmitter.fire(item);
	}

	show(): void {}

	hide(): void {
		this.hideEmitter.fire();
	}

	dispose(): void {
		this.acceptEmitter.dispose();
		this.valueEmitter.dispose();
		this.hideEmitter.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
