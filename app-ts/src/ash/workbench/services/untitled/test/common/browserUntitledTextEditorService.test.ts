import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { URI } from "../../../../../base/common/uri.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IQuickInputService, type IQuickInputService as IQuickInputServiceContract, type IQuickPick, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IEditorPart as IEditorPartContract } from "../../../../browser/parts/editor/editorPart.js";
import { ExtensionFileTemplateRegistry } from "../../../extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../extensions/common/extensionService.js";
import { BrowserUntitledTextEditorService } from "../../browser/browserUntitledTextEditorService.js";
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
	using service = services.createInstance(BrowserUntitledTextEditorService);
	const first = service.create();
	const second = service.create({ initialText: "draft", languageId: "typescript" });

	assert.equal(first.resource.toString(), "untitled:/Untitled-1");
	assert.equal(first.label, "Untitled-1");
	assert.equal(first.initialText, "");
	assert.equal(second.resource.toString(), "untitled:/Untitled-2");
	assert.equal(second.initialText, "draft");
	assert.equal(second.languageId, "typescript");
	assert.equal(service.get(first.resource), first);
	assert.equal(service.get(URI.file("C:/project/main.ts")), undefined);
	assert.equal(service.isUntitled(first.resource), true);
	assert.equal(service.isUntitled(URI.file("C:/project/main.ts")), false);
});

test("untitled service publishes display-label changes without changing resource identity", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using service = services.createInstance(BrowserUntitledTextEditorService);
	const editor = service.create();
	const changes: string[] = [];
	using listener = service.onDidChangeLabel(value => changes.push(value.label));
	using inputListener = editor.onDidChangeLabel(() => changes.push(`input:${editor.label}`));

	const renamed = service.rename(editor.resource, "Scratch");
	assert.equal(renamed, editor);
	assert.equal(renamed?.resource.toString(), editor.resource.toString());
	assert.equal(renamed?.label, "Scratch");
	assert.equal(editor.label, "Scratch");
	assert.equal(service.get(editor.resource)?.label, "Scratch");
	assert.deepEqual(changes, ["input:Scratch", "Scratch"]);
	assert.equal(service.rename(URI.file("C:/project/main.ts"), "Other"), undefined);
});

test("restored untitled resources are reused and reserve their document numbers", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using service = services.createInstance(BrowserUntitledTextEditorService);
	const resource = URI.parse("untitled:/Untitled-7");
	const restored = service.create({ untitledResource: resource, initialText: "recovered draft", languageId: "typescript", label: 'Recovered draft' });

	assert.equal(service.create({ untitledResource: resource, initialText: "stale" }), restored);
	assert.deepEqual({ restored: restored.initialText, label: restored.label, next: service.create().resource.toString() }, {
		restored: "recovered draft",
		label: 'Recovered draft',
		next: "untitled:/Untitled-8",
	});
	service.reset();
	assert.equal(service.get(resource), undefined);
	assert.equal(service.create().resource.toString(), "untitled:/Untitled-1");
});

test("closing the last working copy releases its untitled identity", () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using service = services.createInstance(BrowserUntitledTextEditorService);
	const editor = service.create();
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
	const registration = workingCopies.register(copy);

	registration.dispose();
	assert.equal(service.get(editor.resource), undefined);
});

test("New Untitled Text Editor opens a compatible text editor input", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using untitled = services.createInstance(BrowserUntitledTextEditorService);
	const opened: Array<{ readonly resource: URI; readonly label?: string; readonly initialText?: string }> = [];
	const editorPart = { openEditor: async (input: typeof opened[number]) => { opened.push(input); } } as unknown as IEditorPartContract;
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, editorPart);
	using commands = new CommandService(services);

	await commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);

	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.resource.toString(), "untitled:/Untitled-1");
	assert.equal(opened[0]?.label, "Untitled-1");
	assert.equal(opened[0]?.initialText, "");
});

test('Repeated New Untitled commands preserve every document while the first editor is loading', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using untitled = services.createInstance(BrowserUntitledTextEditorService);
	const firstLoad = new DeferredPromise<void>();
	const opened: string[] = [];
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, { openEditor: async (input: { label: string }) => {
		opened.push(input.label);
		if (opened.length === 1) await firstLoad.p;
	} } as unknown as IEditorPartContract);
	using commands = new CommandService(services);
	const requests = Array.from({ length: 3 }, () => commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID));
	const beforeFirstLoad = [...opened];
	await firstLoad.complete();
	await Promise.all(requests);
	assert.deepEqual({ beforeFirstLoad, opened }, { beforeFirstLoad: ['Untitled-1'], opened: ['Untitled-1', 'Untitled-2', 'Untitled-3'] });
});

test('New Untitled continues opening queued documents after an editor fails', async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using untitled = services.createInstance(BrowserUntitledTextEditorService);
	const firstLoad = new DeferredPromise<void>();
	const opened: string[] = [];
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, { openEditor: async (input: { label: string }) => {
		opened.push(input.label);
		if (opened.length === 1) await firstLoad.p;
	} } as unknown as IEditorPartContract);
	using commands = new CommandService(services);
	const failed = assert.rejects(commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID), /First editor failed/);
	const second = commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);
	const beforeFailure = [...opened];
	await firstLoad.error(new Error('First editor failed'));
	await Promise.all([failed, second]);
	assert.deepEqual({ beforeFailure, opened }, { beforeFailure: ['Untitled-1'], opened: ['Untitled-1', 'Untitled-2'] });
});

for (const boundary of ['workspace reset', 'window disposal'] as const) {
	test(`New Untitled cancels queued documents after ${boundary}`, async () => {
		using workingCopies = new BrowserWorkingCopyService();
		using services = new InstantiationService();
		services.registerInstance(IWorkingCopyService, workingCopies);
		using untitled = services.createInstance(BrowserUntitledTextEditorService);
		const firstLoad = new DeferredPromise<void>();
		const opened: string[] = [];
		services.registerInstance(IUntitledTextEditorService, untitled);
		services.registerInstance(IEditorPart, { openEditor: async (input: { label: string }) => {
			opened.push(input.label);
			if (opened.length === 1) await firstLoad.p;
		} } as unknown as IEditorPartContract);
		using commands = new CommandService(services);
		const first = commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);
		const pending = commands.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID);
		const cancelled = assert.rejects(pending, isCancellationError);
		if (boundary === 'workspace reset') {
			untitled.reset();
			untitled.create();
			untitled.create();
		} else {
			untitled.dispose();
		}
		await firstLoad.complete();
		await Promise.all([first, cancelled]);
		assert.deepEqual(opened, ['Untitled-1']);
	});
}

test("New File from Template opens the selected extension template as an untitled editor", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	using services = new InstantiationService();
	services.registerInstance(IWorkingCopyService, workingCopies);
	using untitled = services.createInstance(BrowserUntitledTextEditorService);
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
	assert.equal(opened[0]?.resource.toString(), "untitled:/Untitled-1");
	assert.equal(opened[0]?.initialText, "export class Example {}\n");
	assert.equal(opened[0]?.languageId, "typescript");
});

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
