import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { MarkerSeverity } from "../../../../../platform/markers/common/markers.js";
import { MarkerService } from "../../../../../platform/markers/common/markerService.js";
import { type EditorOpenOptions, type IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

test("ProblemsViewPane filters diagnostics and opens the selected range", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	const installedGlobals = installDomGlobals(browser);
	const main = URI.file("C:\\project\\src\\main.rs");
	const library = URI.file("C:\\project\\src\\lib.rs");
	using markerService = new MarkerService();
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	let menu: IContextMenuDelegate | undefined;
	const copied: string[] = [];
	let copyFailure = false;
	const clipboard = { writeText: async (text: string) => { if (copyFailure) throw new Error('Denied'); copied.push(text); } } as IClipboardService;
	const contextMenus = { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as unknown as IContextMenuService;
	markerService.changeAll("fixture", [
		marker(main, MarkerSeverity.Error, "cannot find value", 1),
		marker(main, MarkerSeverity.Warning, "unused import", 2),
		marker(library, MarkerSeverity.Info, "consider simplifying", 4),
	]);
	let opened: { readonly input: IResourceEditorInput; readonly options?: EditorOpenOptions; } | undefined;
	let focusCount = 0;
	const editorService: IEditorService = {
		...emptyEditorServiceState,
		openEditor: async (input, options) => { opened = { input, options }; if (options?.preserveFocus !== true) focusCount += 1; },
		focusActiveEditor() { focusCount += 1; },
	};

	try {
		const { ProblemsViewPane } = await import("../../../../../workbench/contrib/problems/browser/problemsViewPane.js");
		using pane = new ProblemsViewPane(browser.window.document.body, { id: "ash.problems", title: "Problems" }, markerService, editorService, workspace, contextMenus, clipboard);
		browser.window.document.body.append(pane.element);
		const titleControls = pane.partTitleProjection.actions!;
		browser.window.document.body.append(titleControls);
		assert.equal(pane.element.querySelector('.ash-problems-controls'), null);
		const filterAction = titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.filter'] button")!;
		assert.equal(filterAction.getAttribute('aria-haspopup'), 'menu');
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 3);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "3 problems in the workspace.");
		assert.ok(titleControls.querySelector('.ash-problems-filter')!.contains(filterAction));
		titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.collapseAll'] button")!.click();
		assert.ok([...pane.element.querySelectorAll<HTMLButtonElement>('.ash-problems-file-heading')].every(heading => heading.getAttribute('aria-expanded') === 'false'));
		assert.ok([...pane.element.querySelectorAll<HTMLUListElement>('.ash-problems-file-items')].every(rows => rows.hidden));
		const heading = pane.element.querySelector<HTMLButtonElement>('.ash-problems-file-heading')!;
		heading.click();
		assert.equal(heading.getAttribute('aria-expanded'), 'true');
		titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.copy'] button")!.click();
		await Promise.resolve();
		assert.equal(copied[0]!.split('\n').length, 3);
		assert.ok(copied[0]!.includes('cannot find value fixture'));
		assert.ok(copied[0]!.includes('unused import fixture'));

		const filter = titleControls.querySelector<HTMLInputElement>(".ash-problems-filter input")!;

		filter.value = "lib.rs";
		filter.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 1);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "1 of 3 problems shown.");
		titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.copy'] button")!.click();
		await Promise.resolve();
		assert.equal(copied[1], `${library.fsPath}(5,1): Information: consider simplifying fixture`);

		filter.value = "";
		filter.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
		filterAction.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.ok(menu);
		await menu.getActions().find(action => action.id.endsWith('.warning'))!.run();
		menu.onHide?.(false);
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 2);
		filterAction.click();
		assert.equal(menu.getActions().find(action => action.id.endsWith('.warning'))!.checked, false);
		menu.onHide?.(true);

		pane.element.querySelector<HTMLButtonElement>(".ash-problems-item.error .ash-problems-item-button")!.click();
		await Promise.resolve();
		assert.equal(opened?.input.resource.toString(), main.toString());
		assert.deepEqual(opened?.options?.selection, Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (4) + 1)));
		assert.equal(focusCount, 1);

		markerService.changeAll("fixture", []);
		assert.equal(pane.element.querySelectorAll(".ash-problems-item").length, 0);
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "No problems detected.");
		workspace.updateWorkspace({ id: 'empty' });
		assert.equal(pane.element.querySelector(".ash-problems-status")?.textContent, "Open a folder to view project diagnostics.");

		initializeTestLocalization('zh-CN');
		markerService.changeAll('fixture', [marker(main, MarkerSeverity.Error, 'cannot find value', 1)]);
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '工作区中有 1 个问题。');
		assert.equal(pane.element.querySelector('.ash-problems-location')?.textContent, '[第 2 行，第 1 列]');
		filter.value = 'missing';
		filter.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '没有匹配当前筛选条件的问题（共 1 个）。');
		const clear = pane.element.querySelector<HTMLButtonElement>('.ash-problems-status-row button')!;
		assert.equal(clear.hidden, false);
		clear.click();
		assert.equal(filter.value, '');
		assert.equal(clear.hidden, true);
		assert.equal(browser.window.document.activeElement, filter);
		assert.equal(pane.element.querySelectorAll('.ash-problems-item').length, 1);
		filterAction.click();
		assert.ok(menu.getActions().every(action => action.checked));
		menu.onHide?.(true);
		markerService.changeAll('fixture', []);
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '打开文件夹以查看项目诊断。');
		workspace.updateWorkspace({ id: 'project', uri: URI.file('/project') });
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '当前没有问题。');
		assert.equal(titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.copy'] button")!.disabled, true);
		markerService.changeAll('fixture', [marker(main, MarkerSeverity.Error, 'cannot find value', 1)]);
		copyFailure = true;
		titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.copy'] button")!.click();
		await Promise.resolve();
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '无法复制问题。');
		copyFailure = false;
		titleControls.querySelector<HTMLButtonElement>("[data-action-id='ash.problems.copy'] button")!.click();
		await Promise.resolve();
		assert.equal(pane.element.querySelector('.ash-problems-status')?.textContent, '工作区中有 1 个问题。');
	} finally {
		resetNlsResolver();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

function marker(resource: URI, severity: MarkerSeverity, message: string, lineNumber: number) {
	return { resource, marker: { startLineNumber: (lineNumber) + 1, startColumn: 1, endLineNumber: (lineNumber) + 1, endColumn: 5, severity, message, source: "fixture" } };
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
