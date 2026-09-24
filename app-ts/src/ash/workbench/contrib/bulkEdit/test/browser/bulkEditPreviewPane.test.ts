import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type LanguageWorkspaceEdit } from "../../../../../editor/common/languages.js";
import { type BulkEditPreviewModel } from "../../common/bulkEdit.js";

test("bulk edit preview applies only the selected valid entries", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const first = URI.file("C:\\workspace\\first.ts");
	const second = URI.file("C:\\workspace\\second.ts");
	const edit: LanguageWorkspaceEdit = {
		entries: [
			{ kind: "textDocument", resource: first, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "one" }] },
			{ kind: "textDocument", resource: second, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "two" }] },
		],
	};
	const model: BulkEditPreviewModel = {
		edit,
		entries: [
			{ index: 0, kind: "textDocument", resource: first, detail: "1 text edit" },
			{ index: 1, kind: "textDocument", resource: second, detail: "1 text edit" },
		],
		canApply: true,
	};

	try {
		const { BulkEditPreviewPane } = await import("../../browser/preview/bulkEditPreviewPane.js");
		using pane = new BulkEditPreviewPane(browser.window.document.body, { id: "ash.bulkEditPreview", title: "Refactor Preview" });
		browser.window.document.body.append(pane.element);
		const pending = pane.setInput(model, new AbortController().signal);
		const checkboxes = [...pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
		assert.equal(checkboxes.length, 2);
		assert.equal(checkboxes[0]!.checked, true);
		assert.equal(checkboxes[1]!.checked, true);

		checkboxes[1]!.click();
		assert.equal(checkboxes[1]!.checked, false);
		assert.match(pane.element.querySelector(".ash-bulk-edit-status")?.textContent ?? "", /1 selected/);
		pane.element.querySelector<HTMLButtonElement>(".ash-bulk-edit-apply")!.click();

		const accepted = await pending;
		assert.deepEqual(accepted?.entries, [edit.entries[0]]);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("disposing a bulk edit preview settles the pending approval", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const resource = URI.file("C:\\workspace\\first.ts");
	const edit: LanguageWorkspaceEdit = { entries: [{ kind: "textDocument", resource, edits: [] }] };
	const model: BulkEditPreviewModel = {
		edit,
		entries: [{ index: 0, kind: "textDocument", resource, detail: "0 text edits" }],
		canApply: true,
	};

	try {
		const { BulkEditPreviewPane } = await import("../../browser/preview/bulkEditPreviewPane.js");
		const pane = new BulkEditPreviewPane(browser.window.document.body, { id: "ash.bulkEditPreview", title: "Refactor Preview" });
		const pending = pane.setInput(model, new AbortController().signal);
		pane.dispose();
		assert.equal(await pending, undefined);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

test("bulk edit preview keeps resource operations linked to dependent text edits", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const created = URI.file("C:\\workspace\\created.ts");
	const independent = URI.file("C:\\workspace\\independent.ts");
	const edit: LanguageWorkspaceEdit = {
		entries: [
			{ kind: "create", resource: created, existing: "error" },
			{ kind: "textDocument", resource: created, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "created" }] },
			{ kind: "textDocument", resource: independent, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "independent" }] },
		],
	};
	const model: BulkEditPreviewModel = {
		edit,
		entries: [
			{ index: 0, kind: "create", resource: created, detail: "Create file" },
			{ index: 1, kind: "textDocument", resource: created, detail: "1 text edit" },
			{ index: 2, kind: "textDocument", resource: independent, detail: "1 text edit" },
		],
		canApply: true,
	};

	try {
		const { BulkEditPreviewPane } = await import("../../browser/preview/bulkEditPreviewPane.js");
		using pane = new BulkEditPreviewPane(browser.window.document.body, { id: "ash.bulkEditPreview", title: "Refactor Preview" });
		const pending = pane.setInput(model, new AbortController().signal);
		const createCheckbox = pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0]!;
		createCheckbox.checked = false;
		createCheckbox.dispatchEvent(new browser.window.Event("change", { bubbles: true }));
		const checkboxes = [...pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
		assert.equal(checkboxes[0]!.checked, false);
		assert.equal(checkboxes[1]!.checked, false);
		assert.equal(checkboxes[2]!.checked, true);
		pane.element.querySelector<HTMLButtonElement>(".ash-bulk-edit-apply")!.click();

		const accepted = await pending;
		assert.deepEqual(accepted?.entries, [edit.entries[2]]);
	} finally {
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

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
