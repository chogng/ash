import { StandaloneCodeEditorService } from '../../../standalone/browser/standaloneCodeEditorService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Range } from "../../../common/core/range.js";
import { type DiffComputationRequest, type IDiffComputationService } from "../../../common/diff/diffComputationService.js";
import { LineDiffKind, type LineDiff } from "../../../common/diff/lineDiff.js";
import { TextModel } from "../../../common/model/textModel.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DiffEditorWidget } = await import("../../../browser/widget/diffEditor/diffEditorWidget.js");
const { DiffModel } = await import("../../../common/diff/diffModel.js");
const { createEditorBrowserServices } = await import('../../../browser/services/contribution.js');

test("DiffEditorWidget presents side-by-side changed lines and inline ranges", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using original = new TextModel("same\nold value\nremoved\ntail");
	using modified = new TextModel("same\nnew value\nadded\ntail");
	using computationService = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, computationService });
	await waitForReady(model);
	const services = createEditorBrowserServices(new StandaloneCodeEditorService());
	using codeEditorService = services.codeEditorService;
	const lifecycle: string[] = [];
	using willCreate = codeEditorService.onWillCreateDiffEditor(() => lifecycle.push('will'));
	using added = codeEditorService.onDiffEditorAdd(() => lifecycle.push('add'));
	using removed = codeEditorService.onDiffEditorRemove(() => lifecycle.push('remove'));
	const editor = new DiffEditorWidget({ container, model, lineHeight: 20, codeEditorService });
	assert.deepEqual(lifecycle, ['will', 'add']);
	assert.deepEqual(codeEditorService.listDiffEditors(), [editor]);
	editor.layout({ width: 400, height: 80 });

	const rows = [...editor.element.querySelectorAll<HTMLElement>(".stanza-diff-editor-row")];
	assert.equal(rows.length, 4);
	assert.equal(rows[0]?.classList.contains("unchanged"), true);
	assert.equal(rows[1]?.classList.contains("modified"), true);
	assert.equal(rows[1]?.querySelector(".stanza-diff-editor-cell.original")?.textContent, "2old value");
	assert.equal(rows[1]?.querySelector(".stanza-diff-editor-cell.modified")?.textContent, "2new value");
	assert.equal(rows[1]?.querySelectorAll(".stanza-diff-editor-inline.removed").length, 1);
	assert.equal(rows[1]?.querySelectorAll(".stanza-diff-editor-inline.added").length, 1);
	const overview = requiredElement<HTMLElement>(editor.element, ".stanza-diff-overview");
	assert.equal(overview.style.left, "370px");
	assert.equal(overview.style.height, "80px");
	assert.equal(overview.querySelectorAll(".stanza-diff-overview-lane.original .stanza-diff-overview-marker.removed").length, 1);
	assert.equal(overview.querySelectorAll(".stanza-diff-overview-lane.modified .stanza-diff-overview-marker.inserted").length, 1);
	assert.equal(requiredElement<HTMLElement>(overview, ".stanza-diff-overview-viewport").style.height, "80px");
	assert.equal(editor.nextChange(), 1);
	assert.equal(editor.currentChangeRow, 1);
	assert.equal(editor.element.querySelector(".stanza-diff-editor-row.active")?.classList.contains("modified"), true);
	assert.equal(editor.previousChange(), 2);
	const next = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F7" });
	editor.element.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	assert.equal(editor.currentChangeRow, 1);
	assert.match(editor.element.querySelector(".stanza-diff-editor-accessibility-status")?.textContent ?? "", /Change 1 of 2/);
	editor.dispose();
	assert.deepEqual(lifecycle, ['will', 'add', 'remove']);
	assert.deepEqual(codeEditorService.listDiffEditors(), []);
	dom.window.close();
});

test("DiffEditorWidget refreshes on either source model and virtualizes diff rows", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using original = new TextModel(lines("old", 100));
	using modified = new TextModel(lines("new", 100));
	using computationService = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, computationService });
	await waitForReady(model);
	using editor = new DiffEditorWidget({ container, model, lineHeight: 20, overscanRowCount: 1 });
	editor.layout({ width: 400, height: 40 });

	assert.equal(editor.element.querySelectorAll(".stanza-diff-editor-row").length, 3);
	editor.revealModifiedLine(80);
	const firstVisibleRow = editor.element.querySelector<HTMLElement>(".stanza-diff-editor-row");
	assert.equal(firstVisibleRow?.style.height, "20px");
	assert.ok(editor.element.scrollTop > 0);
	const rows = requiredElement<HTMLElement>(editor.element, ".stanza-diff-editor-rows");
	assert.notEqual(rows.style.top, "0px");
	assert.equal(rows.style.transform, "");
	const overview = requiredElement<HTMLElement>(editor.element, ".stanza-diff-overview");
	assert.equal(overview.style.top, `${editor.element.scrollTop}px`);
	assert.equal(Number.parseFloat(requiredElement<HTMLElement>(overview, ".stanza-diff-overview-viewport").style.height), 2);
	assert.equal(requiredElement<HTMLElement>(overview, ".stanza-diff-overview-viewport").style.transform === "translate3d(0, 0px, 0)", false);

	modified.applyEdits([{
		range: Range.fromPositions(modified.positionAt(0), modified.positionAt(modified.getText().length)),
		text: "same",
	}]);
	await waitForReady(model);
	assert.equal(editor.diff?.rows.length, 100);
	editor.element.scrollTop = 0;
	editor.element.dispatchEvent(new dom.window.Event("scroll"));
	assert.equal(overview.style.top, "0px");
	assert.equal(requiredElement<HTMLElement>(overview, ".stanza-diff-overview-viewport").style.transform, "translate3d(0, 0px, 0)");
	assert.equal(editor.element.querySelector(".stanza-diff-editor-row")?.classList.contains("modified"), true);
	dom.window.close();
});

test("DiffEditorWidget applies presentation settings and clamps change navigation when looping is disabled", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using original = new TextModel("old\nsame\nold again");
	using modified = new TextModel("new\nsame\nnew again");
	using computationService = new WidgetTestDiffComputationService();
	using model = new DiffModel({ original, modified, computationService });
	await waitForReady(model);
	using editor = new DiffEditorWidget({ container, model, lineHeight: 24, fontFamily: "Test Mono", fontSize: 15, fontLigatures: true, showLineNumbers: false, showInlineChanges: false, loopChanges: false });
	editor.layout({ width: 400, height: 80 });

	assert.equal(editor.element.classList.contains("hide-line-numbers"), true);
	assert.equal(editor.element.style.fontFamily.startsWith('"Test Mono", '), true);
	assert.equal(editor.element.style.fontFamily.endsWith('monospace'), true);
	assert.equal(editor.element.style.fontSize, "15px");
	assert.equal(editor.element.style.fontFeatureSettings.includes('"liga" on'), true);
	assert.equal(editor.element.style.lineHeight, '24px');
	assert.equal(editor.element.querySelectorAll(".stanza-diff-editor-inline").length, 0);
	assert.equal(editor.nextChange(), 0);
	assert.equal(editor.nextChange(), 2);
	assert.equal(editor.nextChange(), 2);
	assert.equal(editor.previousChange(), 0);
	assert.equal(editor.previousChange(), 0);
	dom.window.close();
});

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");
}

class WidgetTestDiffComputationService implements IDiffComputationService {
	async compute(request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		signal.throwIfAborted();
		const originalLines = request.original.text.split("\n");
		const modifiedLines = request.modified.text.split("\n");
		const rows = Array.from({ length: Math.max(originalLines.length, modifiedLines.length) }, (_, index) => {
			const original = originalLines[index];
			const modified = modifiedLines[index];
			if (original === undefined) {
				return Object.freeze({ kind: LineDiffKind.Added, modifiedLineIndex: index, originalChanges: Object.freeze([]), modifiedChanges: Object.freeze([]) });
			}
			if (modified === undefined) {
				return Object.freeze({ kind: LineDiffKind.Removed, originalLineIndex: index, originalChanges: Object.freeze([]), modifiedChanges: Object.freeze([]) });
			}
			if (original === modified) {
				return Object.freeze({ kind: LineDiffKind.Unchanged, originalLineIndex: index, modifiedLineIndex: index, originalChanges: Object.freeze([]), modifiedChanges: Object.freeze([]) });
			}
			return Object.freeze({
				kind: LineDiffKind.Modified,
				originalLineIndex: index,
				modifiedLineIndex: index,
				originalChanges: Object.freeze(original.length === 0 ? [] : [{ startColumn: 0, endColumn: original.length }]),
				modifiedChanges: Object.freeze(modified.length === 0 ? [] : [{ startColumn: 0, endColumn: modified.length }]),
			});
		});
		return Object.freeze({ rows: Object.freeze(rows), hunks: Object.freeze([]) });
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function requiredElement<T extends Element>(owner: ParentNode, selector: string): T {
	const element = owner.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}

function waitForReady(model: InstanceType<typeof DiffModel>): Promise<void> {
	if (model.state.kind === "ready") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const listener = model.onDidChange(state => {
			if (state.kind === "loading") return;
			listener.dispose();
			if (state.kind === "error") reject(state.error);
			else resolve();
		});
	});
}
