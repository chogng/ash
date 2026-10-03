import '../../../../../editor/test/browser/testEditorDom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type LanguageWorkspaceEdit } from "../../../../../editor/common/languages.js";
import { type BulkEditPreviewModel } from "../../browser/preview/bulkEditPreview.js";
import { BulkEditPane } from '../../browser/preview/bulkEditPane.js';
import { registerWindow } from '../../../../../base/browser/window.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

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
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
		browser.window.document.body.append(pane.element);
		const pending = pane.setInput(model, new AbortController().signal);
		const checkboxes = [...pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
		assert.equal(checkboxes.length, 2);
		assert.equal(checkboxes[1] instanceof browser.window.HTMLInputElement, false, 'adopted controls retain the main window constructor');
		assert.equal(checkboxes[0]!.checked, true);
		assert.equal(checkboxes[1]!.checked, true);

		checkboxes[1]!.click();
		assert.equal(checkboxes[1]!.checked, false);
		assert.match(pane.element.querySelector(".ash-bulk-edit-status")?.textContent ?? "", /1 selected/);
		pane.element.querySelector<HTMLButtonElement>(".ash-bulk-edit-apply")!.click();

		const accepted = await pending;
		assert.deepEqual(accepted?.entries, [edit.entries[0]]);
	} finally {
		installedGlobals.dispose();
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
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		const pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
		const pending = pane.setInput(model, new AbortController().signal);
		pane.dispose();
		assert.equal(await pending, undefined);
	} finally {
		installedGlobals.dispose();
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
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
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
		installedGlobals.dispose();
		browser.window.close();
	}
});

test('individual replacements preserve focus, expanded text and selection across grouping', async () => {
	await withPane(async (pane, browser) => {
		const resource = URI.file('/workspace/one.ts');
		const edits = [{ range: new Range(1, 1, 1, 2), text: 'A' }, { range: new Range(1, 2, 1, 3), text: 'B' }];
		const pending = pane.setInput({ edit: { entries: [{ kind: 'textDocument', resource, expectedText: 'ab', edits }] }, entries: [{ index: 0, kind: 'textDocument', resource, detail: 'Two replacements', before: 'ab', after: 'AB' }], canApply: true }, new AbortController().signal);
		const details = pane.element.querySelector('details')!;
		details.open = true;
		const first = pane.element.querySelector<HTMLInputElement>('input[data-text-edit-index="0"]')!;
		first.focus();
		first.click();
		assert.equal(browser.window.document.activeElement, first);
		assert.equal(pane.element.querySelector('input[data-text-edit-index="0"]'), first);
		assert.equal(details.open, true);
		assert.equal(pane.element.querySelector('pre')!.textContent, '- ab\n+ aB');
		pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-group')!.click();
		assert.equal(pane.element.querySelector<HTMLInputElement>('input[data-text-edit-index="0"]')!.checked, false);
		assert.equal(browser.window.document.activeElement, first);
		assert.equal(pane.element.querySelector('details'), details);
		assert.equal(details.open, true);
		pane.element.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
		assert.deepEqual((await pending)?.entries, [{ kind: 'textDocument', resource, expectedText: 'ab', edits: [edits[1]] }]);
	});
});

test('excluding an earlier replacement blocks dependent document steps until their baseline is restored', async () => {
	await withPane(async pane => {
		const resource = URI.file('/workspace/sequential.ts');
		const entries: LanguageWorkspaceEdit['entries'] = [
			{ kind: 'textDocument', resource, expectedText: 'a', edits: [{ range: new Range(1, 1, 1, 2), text: 'long' }] },
			{ kind: 'textDocument', resource, expectedText: 'long', edits: [{ range: new Range(1, 5, 1, 5), text: '!' }] },
		];
		const pending = pane.setInput({
			edit: { entries },
			entries: [
				{ index: 0, kind: 'textDocument', resource, detail: 'First step', before: 'a', after: 'long' },
				{ index: 1, kind: 'textDocument', resource, detail: 'Second step', before: 'long', after: 'long!' },
			],
			canApply: true,
		}, new AbortController().signal);
		pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="0"]')!.click();
		assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-apply')!.disabled, true);
		assert.match(pane.element.querySelector('.ash-bulk-edit-status')!.textContent!, /depend on excluded/);
		pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-select-all')!.click();
		assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-apply')!.disabled, false);
		pane.accept();
		assert.deepEqual((await pending)?.entries, entries);
	});
});

test('unchecking a create operation excludes every dependent rename and text change', async () => {
	await withPane(async pane => {
		const first = URI.file('/workspace/a.ts');
		const second = URI.file('/workspace/b.ts');
		const third = URI.file('/workspace/c.ts');
		const independent = URI.file('/workspace/independent.ts');
		const entries: LanguageWorkspaceEdit['entries'] = [
			{ kind: 'create', resource: first, existing: 'error' },
			{ kind: 'rename', source: first, target: second, existing: 'error' },
			{ kind: 'rename', source: second, target: third, existing: 'error' },
			{ kind: 'textDocument', resource: third, edits: [{ range: new Range(1, 1, 1, 1), text: 'dependent' }] },
			{ kind: 'textDocument', resource: independent, edits: [{ range: new Range(1, 1, 1, 1), text: 'independent' }] },
		];
		const pending = pane.setInput({ edit: { entries }, entries: entries.map((entry, index) => ({ index, kind: entry.kind, resource: entry.kind === 'rename' ? entry.source : entry.resource, detail: 'change' })), canApply: true }, new AbortController().signal);
		pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="0"]')!.click();
		pane.accept();
		assert.deepEqual((await pending)?.entries, [entries[4]]);
	});
});

test('Escape cancels the preview and restores the previously focused control', async () => {
	await withPane(async (pane, browser) => {
		const origin = browser.window.document.createElement('button');
		browser.window.document.body.prepend(origin);
		origin.focus();
		const resource = URI.file('/workspace/one.ts');
		const pending = pane.setInput({ edit: { entries: [{ kind: 'create', resource, existing: 'error' }] }, entries: [{ index: 0, kind: 'create', resource, detail: 'create' }], canApply: true }, new AbortController().signal);
		pane.element.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.deepEqual({ result: await pending, focused: browser.window.document.activeElement === origin, hasInput: pane.hasInput }, { result: undefined, focused: true, hasInput: false });
	});
});

test('Chinese preview labels and accessibility verbosity follow the registered language and setting', async () => {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', catalog.bundles);
	try {
		await withPane(async (pane, _browser, configuration) => {
			assert.deepEqual([...pane.element.querySelectorAll('.ash-bulk-edit-toolbar button')].map(button => button.textContent), ['全部选择', '按类型分组', '应用所选修改', '取消']);
			await configuration.updateValue(AccessibilityVerbositySettingId.BulkEditPreview, false);
			assert.equal(pane.element.querySelector('.ash-bulk-edit')!.hasAttribute('aria-description'), false);
		});
	} finally {
		resetNlsResolver();
	}
});

async function withPane(run: (pane: BulkEditPane, browser: JSDOM, configuration: InMemoryConfigurationService) => Promise<void>): Promise<void> {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	using configuration = new InMemoryConfigurationService();
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	try {
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: 'Refactor Preview' });
		browser.window.document.body.append(pane.element);
		pane.setVisible(true);
		await run(pane, browser, configuration);
	} finally {
		globals.dispose();
		browser.window.close();
	}
}

function installDomGlobals(browser: JSDOM) {
	// Keep the main realm's globals while the pane runs in a registered second window.
	return registerWindow(browser.window as unknown as Window);
}
