import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { ServiceContainer } from "../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickInputService as IQuickInputServiceContract, type IQuickPick, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IEditorPart as IEditorPartContract } from "../../../../browser/parts/editor/editorPart.js";
import { ExtensionFileTemplateRegistry } from "../../../extensions/common/extensionFileTemplate.js";
import { IExtensionService } from "../../../extensions/common/extensionService.js";
import { BrowserUntitledTextEditorService } from "../../browser/browserUntitledTextEditorService.js";
import { IUntitledTextEditorService } from "../../common/untitledTextEditorService.js";
import { CommandService } from "../../../commands/common/commandService.js";

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
const { NewFileFromTemplateCommandId, NewUntitledTextEditorCommandId } = await import("../../../../browser/parts/editor/editorActions.js");

suiteTeardown(() => browserEnvironment.window.close());

test("untitled service creates stable virtual editor identities", () => {
	using service = new BrowserUntitledTextEditorService();
	const first = service.create();
	const second = service.create({ initialText: "draft", languageId: "typescript" });

	assert.equal(first.resource.toString(), "untitled:/Untitled-1");
	assert.equal(first.label, "Untitled-1");
	assert.equal(first.initialText, "");
	assert.equal(second.resource.toString(), "untitled:/Untitled-2");
	assert.equal(second.initialText, "draft");
	assert.equal(second.languageId, "typescript");
	assert.equal(service.get(first.resource), first);
	assert.equal(service.get(URI.file("C:\\project\\main.ts")), undefined);
	assert.equal(service.isUntitled(first.resource), true);
	assert.equal(service.isUntitled(URI.file("C:\\project\\main.ts")), false);
});

test("untitled service publishes display-label changes without changing resource identity", () => {
	using service = new BrowserUntitledTextEditorService();
	const editor = service.create();
	const changes: string[] = [];
	using listener = service.onDidChangeLabel(value => changes.push(value.label));

	const renamed = service.rename(editor.resource, "Scratch");
	assert.equal(renamed?.resource.toString(), editor.resource.toString());
	assert.equal(renamed?.label, "Scratch");
	assert.equal(service.get(editor.resource)?.label, "Scratch");
	assert.deepEqual(changes, ["Scratch"]);
	assert.equal(service.rename(URI.file("C:\\project\\main.ts"), "Other"), undefined);
});

test("New Untitled Text Editor opens a compatible text editor input", async () => {
	using untitled = new BrowserUntitledTextEditorService();
	const opened: Array<{ readonly resource: URI; readonly label?: string; readonly initialText?: string }> = [];
	const editorPart = { openEditor: async (input: typeof opened[number]) => { opened.push(input); } } as unknown as IEditorPartContract;
	const services = new ServiceContainer();
	services.registerInstance(IUntitledTextEditorService, untitled);
	services.registerInstance(IEditorPart, editorPart);
	using commands = new CommandService(services);

	await commands.executeCommand(NewUntitledTextEditorCommandId);

	assert.equal(opened.length, 1);
	assert.equal(opened[0]?.resource.toString(), "untitled:/Untitled-1");
	assert.equal(opened[0]?.label, "Untitled-1");
	assert.equal(opened[0]?.initialText, "");
});

test("New File from Template opens the selected extension template as an untitled editor", async () => {
	using untitled = new BrowserUntitledTextEditorService();
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
	const services = new ServiceContainer();
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
	items: readonly TItem[] = [];
	ariaLabel = '';
	placeholder = "";
	value = "";
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
