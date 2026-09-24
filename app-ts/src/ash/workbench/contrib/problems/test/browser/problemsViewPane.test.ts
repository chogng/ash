import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { MarkerService, MarkerSeverity } from "../../../../../platform/markers/common/markers.js";
import { type EditorInput, type EditorOpenOptions, type IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

test("ProblemsViewPane filters diagnostics and opens the selected range", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const main = URI.file("C:\\project\\src\\main.rs");
	const library = URI.file("C:\\project\\src\\lib.rs");
	using markerService = new MarkerService();
	markerService.set("fixture", [
		marker(main, MarkerSeverity.Error, "cannot find value", 1),
		marker(main, MarkerSeverity.Warning, "unused import", 2),
		marker(library, MarkerSeverity.Information, "consider simplifying", 4),
	]);
	let opened: { readonly input: EditorInput; readonly options?: EditorOpenOptions } | undefined;
	let focusCount = 0;
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened = { input, options }; if (options?.preserveFocus !== true) focusCount += 1; },
		focusActiveEditor() { focusCount += 1; },
	};

	try {
		const { ProblemsViewPane } = await import("../../../../../workbench/contrib/problems/browser/problemsViewPane.js");
		using pane = new ProblemsViewPane(browser.window.document.body, { id: "ash.problems", title: "Problems" }, markerService, editorService);
		browser.window.document.body.append(pane.element);
		const titleActions = pane.partTitleProjection?.actions;
		assert.ok(titleActions);
		browser.window.document.body.append(titleActions);
		const filterAction = titleActions.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.focusFilter'] button");
		assert.ok(filterAction);
		assert.ok(filterAction.querySelector("svg.ash-icon"));
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 3);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "3 problems in the workspace.");

		const filter = pane.element.querySelector<HTMLInputElement>(".ash-problems-filter")!;
		filterAction.click();
		assert.equal(browser.window.document.activeElement, filter);
		filter.value = "lib.rs";
		filter.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 1);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "1 of 3 problems shown.");

		filter.value = "";
		filter.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
		pane.element.querySelector<HTMLButtonElement>(".ash-problems-severity.warning")!.click();
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 2);
		assert.equal(pane.element.querySelector(".ash-problems-severity.warning")?.classList.contains("checked"), false);
		assert.equal(pane.element.querySelector(".ash-problems-severity.warning")?.getAttribute("aria-pressed"), "false");

		pane.element.querySelector<HTMLButtonElement>(".ash-problems-item.error .ash-problems-item-button")!.click();
		await Promise.resolve();
		assert.equal(opened?.input.resource.toString(), main.toString());
		assert.deepEqual(opened?.options?.selection, Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (4) + 1)));
		assert.equal(focusCount, 1);

		markerService.set("fixture", []);
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 0);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "No problems have been detected in the workspace.");
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

function marker(resource: URI, severity: MarkerSeverity, message: string, lineNumber: number) {
	return {
		resource,
		range: { start: { lineIndex: lineNumber, columnIndex: 0 }, end: { lineIndex: lineNumber, columnIndex: 4 } },
		severity,
		message,
		source: "fixture",
	};
}

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
	return Object.keys(globals);
}
