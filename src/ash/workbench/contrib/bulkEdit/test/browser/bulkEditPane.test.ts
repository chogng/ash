import '../../../../../editor/test/browser/testEditorDom.js';
import { ResourceEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { ITextModelResourceService, IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestEditorService, BulkEditTestServices } from './bulkEditTestServices.js';
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
import { BulkEditPane } from '../../browser/preview/bulkEditPane.js';
import { registerWindow } from '../../../../../base/browser/window.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { isMultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import '../../browser/preview/bulkEdit.contribution.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';

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
	const model = {
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
		using fixture = new BulkEditTestServices([
			[URI.file('C:\\workspace\\first.ts'), ''], [URI.file('C:\\workspace\\second.ts'), ''],
			[URI.file('C:\\workspace\\independent.ts'), ''],
			[URI.file('/workspace/one.ts'), 'ab'], [URI.file('/workspace/sequential.ts'), 'a'], [URI.file('/workspace/independent.ts'), ''],
		]);
		services.registerInstance(ITextModelResourceService, fixture.models);
		services.registerInstance(IFileTextModelService, fixture.models);
		services.registerInstance(IWorkingCopyService, fixture.workingCopies);
		services.registerInstance(IFileService, fixture.files);
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorService, new TestEditorService());
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
		browser.window.document.body.append(pane.element);
		const pending = pane.setInput(ResourceEdit.convert(model.edit), new AbortController().signal);
		await previewReady(pane);
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
		assert.deepEqual(accepted, ResourceEdit.convert({ entries: [edit.entries[0]!] }));
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
	const model = {
		edit,
		entries: [{ index: 0, kind: "textDocument", resource, detail: "0 text edits" }],
		canApply: true,
	};

	try {
		using configuration = new InMemoryConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using fixture = new BulkEditTestServices([
			[URI.file('C:\\workspace\\first.ts'), ''], [URI.file('C:\\workspace\\second.ts'), ''],
			[URI.file('C:\\workspace\\independent.ts'), ''],
			[URI.file('/workspace/one.ts'), 'ab'], [URI.file('/workspace/sequential.ts'), 'a'], [URI.file('/workspace/independent.ts'), ''],
		]);
		services.registerInstance(ITextModelResourceService, fixture.models);
		services.registerInstance(IFileTextModelService, fixture.models);
		services.registerInstance(IWorkingCopyService, fixture.workingCopies);
		services.registerInstance(IFileService, fixture.files);
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorService, new TestEditorService());
		const pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
		const pending = pane.setInput(ResourceEdit.convert(model.edit), new AbortController().signal);
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
	const model = {
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
		using fixture = new BulkEditTestServices([
			[URI.file('C:\\workspace\\first.ts'), ''], [URI.file('C:\\workspace\\second.ts'), ''],
			[URI.file('C:\\workspace\\independent.ts'), ''],
			[URI.file('/workspace/one.ts'), 'ab'], [URI.file('/workspace/sequential.ts'), 'a'], [URI.file('/workspace/independent.ts'), ''],
		]);
		services.registerInstance(ITextModelResourceService, fixture.models);
		services.registerInstance(IFileTextModelService, fixture.models);
		services.registerInstance(IWorkingCopyService, fixture.workingCopies);
		services.registerInstance(IFileService, fixture.files);
		using contextKeys = new ContextKeyService();
		services.registerInstance(IContextKeyService, contextKeys);
		services.registerInstance(IEditorService, new TestEditorService());
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: "Refactor Preview" });
		const pending = pane.setInput(ResourceEdit.convert(model.edit), new AbortController().signal);
		await previewReady(pane);
		const createCheckbox = pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0]!;
		createCheckbox.checked = false;
		createCheckbox.dispatchEvent(new browser.window.Event("change", { bubbles: true }));
		const checkboxes = [...pane.element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
		assert.equal(checkboxes[0]!.checked, false);
		assert.equal(checkboxes[1]!.checked, false);
		assert.equal(checkboxes[2]!.checked, true);
		pane.element.querySelector<HTMLButtonElement>(".ash-bulk-edit-apply")!.click();

		const accepted = await pending;
		assert.deepEqual(accepted, ResourceEdit.convert({ entries: [edit.entries[2]!] }));
	} finally {
		installedGlobals.dispose();
		browser.window.close();
	}
});

test('individual replacements preserve focus, expanded text and selection across grouping', async () => {
	await withPane(async (pane, browser) => {
		const resource = URI.file('/workspace/one.ts');
		const edits = [{ range: new Range(1, 1, 1, 2), text: 'A' }, { range: new Range(1, 2, 1, 3), text: 'B' }];
		const pending = pane.setInput(ResourceEdit.convert({ entries: [{ kind: 'textDocument', resource, expectedText: 'ab', edits }] }), new AbortController().signal);
		await previewReady(pane);
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
		assert.deepEqual((await pending)?.map(edit => edit instanceof ResourceTextEdit ? edit.textEdit : edit), [edits[1]]);
	});
});

test('excluding an earlier replacement blocks dependent document steps until their baseline is restored', async () => {
	await withPane(async pane => {
		const resource = URI.file('/workspace/sequential.ts');
		const entries: LanguageWorkspaceEdit['entries'] = [
			{ kind: 'textDocument', resource, expectedText: 'a', edits: [{ range: new Range(1, 1, 1, 2), text: 'long' }] },
			{ kind: 'textDocument', resource, expectedText: 'long', edits: [{ range: new Range(1, 5, 1, 5), text: '!' }] },
		];
		const pending = pane.setInput(ResourceEdit.convert({ entries }), new AbortController().signal);
		await previewReady(pane);
		pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="0"]')!.click();
		assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-apply')!.disabled, true);
		assert.match(pane.element.querySelector('.ash-bulk-edit-status')!.textContent!, /depend on excluded/);
		pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-select-all')!.click();
		assert.equal(pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-apply')!.disabled, false);
		pane.accept();
		assert.deepEqual(await pending, ResourceEdit.convert({ entries }));
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
		const pending = pane.setInput(ResourceEdit.convert({ entries }), new AbortController().signal);
		await previewReady(pane);
		pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="0"]')!.click();
		pane.accept();
		assert.deepEqual(await pending, ResourceEdit.convert({ entries: [entries[4]!] }));
	});
});

test('Escape cancels the preview and restores the previously focused control', async () => {
	await withPane(async (pane, browser) => {
		const origin = browser.window.document.createElement('button');
		browser.window.document.body.prepend(origin);
		origin.focus();
		const resource = URI.file('/workspace/new.ts');
		const pending = pane.setInput(ResourceEdit.convert({ entries: [{ kind: 'create', resource, existing: 'error' }] }), new AbortController().signal);
		await previewReady(pane);
		pane.element.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.deepEqual({ result: await pending, focused: browser.window.document.activeElement === origin, hasInput: pane.hasInput }, { result: undefined, focused: true, hasInput: false });
	});
});

test('Chinese preview labels and accessibility verbosity follow the registered language and setting', async () => {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', catalog.bundles);
	try {
		await withPane(async (pane, _browser, configuration) => {
			const setting = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration('files.refactoring.autoSave')!.setting!;
			assert.equal(setting.title, '重构后保存文件');
			assert.equal(setting.description, '控制是否自动保存重构修改的文件。');
			assert.deepEqual([...pane.element.querySelectorAll('.ash-bulk-edit-toolbar button')].map(button => button.textContent), ['全部选择', '按类型分组', '打开修改', '应用所选修改', '取消']);
			await configuration.updateValue(AccessibilityVerbositySettingId.BulkEditPreview, false);
			assert.equal(pane.element.querySelector('.ash-bulk-edit')!.hasAttribute('aria-description'), false);
		});
	} finally {
		resetNlsResolver();
	}
});

async function withPane(run: (pane: BulkEditPane, browser: JSDOM, configuration: InMemoryConfigurationService, services: InstantiationService) => Promise<void>): Promise<void> {
	const browser = new JSDOM('<!doctype html><body></body>');
	const globals = installDomGlobals(browser);
	using configuration = new InMemoryConfigurationService();
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	using fixture = new BulkEditTestServices([
		[URI.file('C:\\workspace\\first.ts'), ''], [URI.file('C:\\workspace\\second.ts'), ''],
		[URI.file('C:\\workspace\\independent.ts'), ''],
		[URI.file('/workspace/one.ts'), 'ab'], [URI.file('/workspace/sequential.ts'), 'a'], [URI.file('/workspace/independent.ts'), ''],
	]);
	services.registerInstance(ITextModelResourceService, fixture.models);
	services.registerInstance(IFileTextModelService, fixture.models);
	services.registerInstance(IWorkingCopyService, fixture.workingCopies);
	services.registerInstance(IFileService, fixture.files);
	using contextKeys = new ContextKeyService();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(IEditorService, new TestEditorService());
	try {
		using pane = services.createInstance(BulkEditPane, browser.window.document.body, { id: BulkEditPane.ID, title: 'Refactor Preview' });
		browser.window.document.body.append(pane.element);
		pane.setVisible(true);
		await run(pane, browser, configuration, services);
	} finally {
		globals.dispose();
		browser.window.close();
	}
}

test('standard preview commands change grouping, selection and the accepted edits', async () => {
	await withPane(async (pane, _browser, _configuration, services) => {
		services.registerInstance(IViewsService, { openView: async () => pane, getViewWithId: () => pane, focusView: async () => { pane.focus(); return true; } } as unknown as IViewsService);
		using commands = new CommandService(services);
		const edits = ResourceEdit.convert({ entries: [{ kind: 'textDocument', resource: URI.file('/workspace/one.ts'), edits: [{ range: new Range(1, 1, 1, 2), text: 'A' }, { range: new Range(1, 2, 1, 3), text: 'B' }] }] });
		const pending = pane.setInput(edits, new AbortController().signal);
		await previewReady(pane);
		await commands.executeCommand('refactorPreview.groupByType');
		assert.equal(pane.element.querySelector('.ash-bulk-edit-group-label')!.textContent, 'Text changes');
		const first = pane.element.querySelector<HTMLInputElement>('input[data-text-edit-index="0"]')!;
		first.focus();
		await commands.executeCommand('refactorPreview.toggleCheckedState');
		assert.equal(first.checked, false);
		await commands.executeCommand('refactorPreview.toggleGrouping');
		assert.equal(pane.element.querySelector('.ash-bulk-edit-group-label')!.textContent, 'one.ts');
		await commands.executeCommand('refactorPreview.apply');
		assert.deepEqual(await pending, [edits[1]]);
	});
});

test('Open changes sends the selected replacements as read-only snapshots to the real editor contract', async () => {
	await withPane(async (pane, _browser, _configuration, services) => {
		const resource = URI.file('/workspace/one.ts');
		const pending = pane.setInput(ResourceEdit.convert({ entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 2), text: 'A' }, { range: new Range(1, 2, 1, 3), text: 'B' }] }] }), new AbortController().signal);
		await previewReady(pane);
		pane.element.querySelector<HTMLInputElement>('input[data-text-edit-index="0"]')!.click();
		pane.element.querySelector<HTMLButtonElement>('.ash-bulk-edit-toolbar .ash-bulk-edit-open-diff')!.click();
		const input = (services.get(IEditorService) as TestEditorService).opened[0]!;
		assert.ok(isMultiDiffEditorInput(input));
		assert.deepEqual(input.items.map(item => ({ before: item.original.initialText, after: item.modified.initialText, readonly: [item.original.readOnly, item.modified.readOnly], target: item.goToFile!.resource.toString() })), [{ before: 'ab', after: 'aB', readonly: [true, true], target: resource.toString() }]);
		using reference = await services.get(ITextModelResourceService).acquire({ resource }, new AbortController().signal);
		assert.equal(reference.model.getText(), 'ab');
		pane.discard();
		assert.equal(await pending, undefined);
	});
});

test('preview selection distinguishes two insertions that reuse the same text edit payload', async () => {
	await withPane(async pane => {
		const payload = { range: new Range(1, 1, 1, 1), text: '!' };
		const resource = URI.file('/workspace/one.ts');
		const edits = ResourceEdit.convert({
			entries: [
				{ kind: 'textDocument', resource, expectedText: 'ab', edits: [payload] },
				{ kind: 'textDocument', resource, expectedText: '!ab', edits: [payload] },
			]
		});
		const pending = pane.setInput(edits, new AbortController().signal);
		await previewReady(pane);
		pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="1"]')!.click();
		assert.equal(pane.element.querySelector<HTMLInputElement>('input[data-bulk-edit-index="0"]')!.checked, true);
		pane.accept();
		assert.deepEqual(await pending, [edits[0]]);
	});
});

function installDomGlobals(browser: JSDOM) {
	// Keep the main realm's globals while the pane runs in a registered second window.
	return registerWindow(browser.window as unknown as Window);
}

async function previewReady(pane: BulkEditPane): Promise<void> {
	if (pane.hasInput) { return; }
	await new Promise<void>(resolve => {
		const observer = new pane.element.ownerDocument.defaultView!.MutationObserver(() => {
			if (pane.hasInput) { observer.disconnect(); resolve(); }
		});
		observer.observe(pane.element, { childList: true, subtree: true });
	});
}
