import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../../../../base/common/event.js";
import { Disposable } from "../../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../../base/common/uri.js";
import { InMemoryConfigurationService } from "../../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { BrowserWorkingCopyService } from "../../../../../services/workingCopy/browser/browserWorkingCopyService.js";
import type { IWorkingCopy } from "../../../../../services/workingCopy/common/workingCopyService.js";
import { StatusbarAlignment, StatusbarService } from "../../../../../services/statusbar/browser/statusbar.js";
import { EditorAutoSaveConfiguration, EditorAutoSaveDelayConfiguration } from "../../../../../services/editor/common/editorConfiguration.js";
import type { EditorInput } from "../../editorInput.js";
import type { IEditorPane, EditorPaneStatus } from "../../editorPane.js";
import { EditorPaneVisibility } from "../../editorPane.js";
import type { IEditorPart } from "../../editorPart.js";
import { EditorAutoSaveContribution } from "../../editorAutoSave.js";
import { EditorStatusContribution } from "../../editorStatus.js";

test("EditorAutoSaveContribution saves dirty copies after the configured delay and skips conflicts", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const editorChanges = new Emitter<void>();
	const editorPart = {
		domNode: dom.window.document.body,
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, "afterDelay");
	await configuration.updateValue(EditorAutoSaveDelayConfiguration, 100);
	using workingCopies = new BrowserWorkingCopyService();
	using workingCopy = new TestWorkingCopy(URI.file("C:\\project\\auto-save.ts"));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSaveContribution(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	await waitFor(() => workingCopy.saveCount === 1);
	workingCopy.setExternalChange(true);
	workingCopy.markDirty();
	workingCopy.fireContentChange();
	await delay(130);
	assert.equal(workingCopy.saveCount, 1);

	editorChanges.dispose();
	configuration.dispose();
	dom.window.close();
});

test("EditorAutoSaveContribution observes auxiliary editor window blur", async () => {
	const main = new JSDOM("<!doctype html><body></body>");
	const auxiliary = new JSDOM("<!doctype html><body></body>");
	const editorChanges = new Emitter<void>();
	const state = { domNode: main.window.document.body };
	const editorPart = {
		get domNode() { return state.domNode; },
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, "onWindowChange");
	using workingCopies = new BrowserWorkingCopyService();
	using workingCopy = new TestWorkingCopy(URI.file("C:\\project\\auxiliary-auto-save.ts"));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSaveContribution(editorPart, workingCopies, configuration);

	state.domNode = auxiliary.window.document.body;
	editorChanges.fire();
	workingCopy.markDirty();
	auxiliary.window.dispatchEvent(new auxiliary.window.Event("blur"));
	await waitFor(() => workingCopy.saveCount === 1);

	editorChanges.dispose();
	configuration.dispose();
	main.window.close();
	auxiliary.window.close();
});

test("EditorAutoSaveContribution clears a delay timer through the window that created it", async () => {
	const main = new JSDOM("<!doctype html><body></body>");
	const auxiliary = new JSDOM("<!doctype html><body></body>");
	const editorChanges = new Emitter<void>();
	const state = { domNode: main.window.document.body };
	const editorPart = {
		get domNode() { return state.domNode; },
		activePane: undefined,
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	const configuration = new InMemoryConfigurationService();
	await configuration.updateValue(EditorAutoSaveConfiguration, "afterDelay");
	await configuration.updateValue(EditorAutoSaveDelayConfiguration, 100);
	using workingCopies = new BrowserWorkingCopyService();
	using workingCopy = new TestWorkingCopy(URI.file("C:\\project\\window-timer.ts"));
	using registration = workingCopies.register(workingCopy);
	using contribution = new EditorAutoSaveContribution(editorPart, workingCopies, configuration);

	workingCopy.markDirty();
	state.domNode = auxiliary.window.document.body;
	editorChanges.fire();
	await configuration.updateValue(EditorAutoSaveConfiguration, "off");
	await delay(130);
	assert.equal(workingCopy.saveCount, 0);

	editorChanges.dispose();
	configuration.dispose();
	main.window.close();
	auxiliary.window.close();
});

test("EditorStatusContribution projects and clears active pane status", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const editorChanges = new Emitter<void>();
	const workingCopy = new TestWorkingCopy(URI.file("C:\\project\\status.ts"));
	const pane = new TestStatusPane(workingCopy);
	const input: EditorInput = { resource: workingCopy.resource, languageId: "typescript" };
	const state: { activeInput: EditorInput | undefined; activePane: IEditorPane | undefined } = { activeInput: input, activePane: pane };
	const editorPart = {
		domNode: dom.window.document.body,
		get activeInput() { return state.activeInput; },
		get activePane() { return state.activePane; },
		onDidChangeEditors: editorChanges.event,
	} as unknown as IEditorPart;
	using statusbar = new StatusbarService();
	using contribution = new EditorStatusContribution(editorPart, statusbar);

	assert.deepEqual(statusTexts(statusbar), ["Ln 4, Col 9", "LF  UTF-8", "TypeScript"]);
	workingCopy.markDirty();
	editorChanges.fire();
	assert.deepEqual(statusTexts(statusbar), ["Unsaved", "Ln 4, Col 9", "LF  UTF-8", "TypeScript"]);
	workingCopy.setExternalChange(true);
	editorChanges.fire();
	assert.equal(statusTexts(statusbar)[0], "Conflict");
	pane.setStatus({ lineNumber: 10, columnNumber: 2, selectionCount: 3, languageId: "json", encoding: "UTF-8", endOfLine: "CRLF" });
	assert.deepEqual(statusTexts(statusbar), ["Conflict", "Ln 10, Col 2 (3 selections)", "CRLF  UTF-8", "JSON"]);

	state.activeInput = undefined;
	state.activePane = undefined;
	editorChanges.fire();
	assert.deepEqual(statusTexts(statusbar), []);

	pane.dispose();
	workingCopy.dispose();
	editorChanges.dispose();
	dom.window.close();
});

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly externalEmitter = this._register(new Emitter<void>());
	private readonly contentEmitter = this._register(new Emitter<void>());
	private dirty = false;
	private external = false;
	readonly backupKind = "text" as const;
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeExternalChange = this.externalEmitter.event;
	readonly onDidChangeContent = this.contentEmitter.event;
	saveCount = 0;

	constructor(readonly resource: URI) { super(); }
	get isDirty(): boolean { return this.dirty; }
	get hasExternalChange(): boolean { return this.external; }
	backup(): string { return "content"; }
	restoreBackup(): void { this.markDirty(); }
	markDirty(): void { this.dirty = true; this.dirtyEmitter.fire(); }
	setExternalChange(value: boolean): void { this.external = value; this.externalEmitter.fire(); }
	fireContentChange(): void { this.contentEmitter.fire(); }
	async save(): Promise<void> { this.saveCount += 1; this.dirty = false; this.dirtyEmitter.fire(); }
	async saveAs(): Promise<void> { await this.save(); }
	async revert(): Promise<void> { this.dirty = false; this.dirtyEmitter.fire(); }
}

class TestStatusPane extends Disposable implements IEditorPane {
	readonly id = "test.status";
	private readonly statusEmitter = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this.statusEmitter.event;
	private status: EditorPaneStatus = { lineNumber: 4, columnNumber: 9, languageId: "typescript", encoding: "UTF-8", endOfLine: "LF" };

	constructor(readonly workingCopy: IWorkingCopy) { super(); }
	getStatus(): EditorPaneStatus { return this.status; }
	setStatus(status: EditorPaneStatus): void { this.status = status; this.statusEmitter.fire(); }
	create(): void {}
	async setInput(): Promise<void> {}
	clearInput(): void {}
	layout(): void {}
	setVisible(_visibility: EditorPaneVisibility): void {}
	focus(): void {}
}

function statusTexts(statusbar: StatusbarService): string[] {
	return statusbar.getEntries(StatusbarAlignment.Right).map(item => item.entry.text);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for editor contribution state");
		await delay(5);
	}
}
