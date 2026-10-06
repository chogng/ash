import type { IResourceEditorInput, IEditorPane } from '../../common/editor.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IDecorationsService, type IDecorationData } from '../../services/decorations/common/decorations.js';
import '../../../editor/test/browser/testEditorDom.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { EditorShowIconsConfiguration, EditorLabelFormatConfiguration, EditorTabSizingConfiguration, EditorTabSizingFixedMinWidthConfiguration, EditorTabSizingFixedMaxWidthConfiguration } from '../../services/editor/common/editorConfiguration.js';
import { createTestEditorServices } from '../common/testEditorServices.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { JSDOM } from "jsdom";
import { DndCssClasses } from "../../../base/browser/ui/dnd/dnd.js";
import { URI } from "../../../base/common/uri.js";
import { Emitter } from "../../../base/common/event.js";
import { Position } from "../../../editor/common/core/position.js";
import { Range } from "../../../editor/common/core/range.js";
import type { LanguageDocumentSymbol } from "../../../editor/common/languages.js";
import { TextModel } from "../../../editor/common/model/textModel.js";
import { LanguageFeaturesService } from "../../../editor/common/services/languageFeaturesService.js";
import { InMemoryConfigurationService } from "../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { EditorTabsDelegate } from "../../browser/parts/editor/editorTabsControl.js";
import { MultiEditorTabsControl } from "../../browser/parts/editor/multiEditorTabsControl.js";
import { updateConnectedTabClipping } from "../../browser/parts/editor/connectedTabClipping.js";
import { EditorTitleControl } from "../../browser/parts/editor/editorTitleControl.js";
import { EditorTabsModeConfiguration } from "../../services/editor/common/editorConfiguration.js";
import { BreadcrumbsEnabledConfiguration, BreadcrumbsFilePathConfiguration, BreadcrumbsSymbolPathConfiguration } from "../../browser/parts/editor/breadcrumbs.js";

import { WorkbenchConfiguration } from '../../common/configuration.js';
import { EditorBreadcrumbsControl } from '../../browser/parts/editor/breadcrumbsControl.js';
import { setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../services/localization/common/localizationCatalogs.js';
import { EditorGroupModel } from '../../common/editor/editorGroupModel.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { FileKind } from '../../../platform/files/common/files.js';
import type { FileElement } from '../../browser/parts/editor/breadcrumbsModel.js';

test('Editor breadcrumbs initialize their navigation label in Chinese', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createTestEditorServices();
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
		using control = services.createInstance(EditorBreadcrumbsControl, dom.window.document.body, undefined, undefined);
		control.setInput(input('folder/file.ts'));

		assert.equal(control.domNode.getAttribute('aria-label'), '编辑器面包屑');
		const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(EditorShowIconsConfiguration)?.setting;
		assert.deepEqual([setting?.title, setting?.description], ['工作台 › 编辑器：显示图标', '在编辑器标签中显示文件图标。']);
		const tabStyle = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(WorkbenchConfiguration.modernUIEditorTabStyle)?.setting;
		assert.equal(tabStyle?.title, '编辑器标签样式');
		assert.ok(tabStyle?.valueType === 'select');
		assert.deepEqual(tabStyle.options.map(option => option.label), ['连接式', '独立圆角']);
		const sizing = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(EditorTabSizingConfiguration)!.setting!;
		assert.equal(sizing.title, '工作台 › 编辑器：标签宽度');
		assert.ok(sizing.valueType === 'select');
		assert.deepEqual(sizing.options.map(option => option.label), ['完整显示', '空间不足时缩小', '等宽']);
		assert.deepEqual([EditorTabSizingFixedMinWidthConfiguration, EditorTabSizingFixedMaxWidthConfiguration].map(key => Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key)!.setting!.title), ['工作台 › 编辑器：等宽标签最小宽度', '工作台 › 编辑器：等宽标签最大宽度']);
		assert.equal(control.domNode.querySelector('.ash-breadcrumbs-widget') !== null, true);
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});

test('EditorTitleControl starts breadcrumbs at the owning workspace and refreshes open files when roots change', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = new InMemoryConfigurationService();
		using services = createTestEditorServices(configuration);
		const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
		workspace.updateWorkspace({ id: 'ash', uri: URI.file('/Users/lx/Desktop/ash') });
		const group = new EditorGroupModel();
		let selected: FileElement | undefined;
		using control = services.createInstance(EditorTitleControl, dom.window.document.body, inertDelegate, group, undefined, configuration,
			(element: FileElement) => { selected = element; }, undefined, undefined, undefined, undefined);
		const file = { ...input('engine #1.ts'), resource: URI.file('/Users/lx/Desktop/ash/源 码/engine #1.ts') };
		group.openEditor(file);
		control.setEditors([descriptor(file)], file);
		const labels = (): (string | null)[] => [...control.domNode.querySelectorAll('.ash-editor-breadcrumbs button')].map(button => button.textContent);
		assert.deepEqual(labels(), ['ash', '源 码', 'engine #1.ts']);
		control.domNode.querySelectorAll<HTMLButtonElement>('.ash-editor-breadcrumbs button')[1]!.click();
		assert.deepEqual([selected?.uri.toString(), selected?.kind], [URI.file('/Users/lx/Desktop/ash/源 码').toString(), FileKind.Directory]);

		workspace.updateWorkspace({
			id: 'multi', configuration: URI.file('/workspace.ash-workspace'), folders: [
				{ id: 'ash', uri: URI.file('/Users/lx/Desktop/ash'), name: 'Ash', index: 0 },
				{ id: 'source', uri: URI.file('/Users/lx/Desktop/ash/源 码/'), name: 'Source', index: 1 },
			]
		});
		assert.deepEqual(labels(), ['Source', 'engine #1.ts']);
		control.domNode.querySelector<HTMLButtonElement>('.ash-editor-breadcrumbs button')!.click();
		assert.deepEqual([selected?.uri.toString(), selected?.kind], [URI.file('/Users/lx/Desktop/ash/源 码').toString(), FileKind.Directory]);
		await configuration.updateValue(BreadcrumbsFilePathConfiguration, 'last');
		assert.deepEqual(labels(), ['engine #1.ts']);
		await configuration.updateValue(BreadcrumbsFilePathConfiguration, 'on');
		workspace.updateWorkspace({ id: 'other', uri: URI.file('/Users/lx/Desktop/ash-other') });
		assert.deepEqual(labels(), ['Users', 'lx', 'Desktop', 'ash', '源 码', 'engine #1.ts']);
		workspace.updateWorkspace({ id: 'empty', folders: [] });
		assert.deepEqual(labels(), ['Users', 'lx', 'Desktop', 'ash', '源 码', 'engine #1.ts']);
	} finally {
		dom.window.close();
	}
});

test('Editor breadcrumbs respect URI segment boundaries for remote, Windows and filesystem roots', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createTestEditorServices();
		const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
		using control = services.createInstance(EditorBreadcrumbsControl, dom.window.document.body, undefined, undefined);
		const cases = [
			{ root: 'vscode-remote://ssh-remote+host/home/lx/ash', file: 'vscode-remote://ssh-remote+host/home/lx/ash/src/main.ts', labels: ['ash', 'src', 'main.ts'] },
			{ root: 'vscode-remote://ssh-remote+host/home/lx/ash', file: 'vscode-remote://ssh-remote+other/home/lx/ash/main.ts', labels: ['ssh-remote+other', 'home', 'lx', 'ash', 'main.ts'] },
			{ root: 'file:///C:/Users/lx/ash', file: 'file:///C:/Users/lx/ash/src/main.ts', labels: ['ash', 'src', 'main.ts'] },
			{ root: 'file://server/share/ash', file: 'file://server/share/ash/main.ts', labels: ['ash', 'main.ts'] },
			{ root: 'file:///work/ash', file: 'file:///work/ash%2Fother/main.ts', labels: ['work', 'ash/other', 'main.ts'] },
			{ root: 'file:///work/ash', file: 'file:///work/ash/src%2Fpart/main.ts', labels: ['ash', 'src/part', 'main.ts'] },
			{ root: 'file:///', file: 'file:///main.ts', labels: ['ash', 'main.ts'] },
		];
		for (const scenario of cases) {
			workspace.updateWorkspace({ id: 'test', folders: [{ id: 'root', uri: URI.parse(scenario.root), name: 'ash', index: 0 }] });
			control.setInput({ ...input('main.ts'), resource: URI.parse(scenario.file) });
			assert.deepEqual([...control.domNode.querySelectorAll('button')].map(button => button.textContent), scenario.labels, scenario.file);
		}
	} finally {
		dom.window.close();
	}
});

test('Pinned editor action preserves its target and keyboard focus across state updates', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const unpinned: IResourceEditorInput[] = [];
		using services = createTestEditorServices();
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
		using control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, {
			...inertDelegate,
			unstickEditor: (input: IResourceEditorInput) => { unpinned.push(input); },
		}, new EditorGroupModel());
		const first = input('first');
		const second = input('second');
		const pinned = { ...descriptor(first), sticky: true };
		control.setEditors([pinned, descriptor(second)], second);
		const unpin = control.domNode.querySelector<HTMLButtonElement>('.ash-tab-primary-action.custom-action button')!;
		assert.equal(unpin.getAttribute('aria-label'), '取消固定编辑器');
		assert.equal(unpin.title, '取消固定编辑器');
		unpin.focus();
		control.setEditors([{ ...pinned, isDirty: true }, descriptor(second)], second);
		assert.equal(dom.window.document.activeElement, unpin);
		unpin.click();
		assert.deepEqual(unpinned, [first]);
		const renamed = input('renamed');
		control.setEditors([{ ...pinned, input: renamed }, descriptor(second)], second);
		control.domNode.querySelector<HTMLButtonElement>('.ash-tab-primary-action.custom-action button')!.click();
		assert.deepEqual(unpinned, [first, renamed]);
	} finally {
		resetNlsResolver();
		dom.window.close();
	}
});

test("MultiEditorTabsControl reports the tab edge used as a drag drop insertion point", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const drops: Array<{ target: IResourceEditorInput | undefined; position: "before" | "after"; }> = [];
	const previews: IResourceEditorInput[] = [];
	const keptEditors: IResourceEditorInput[] = [];
	let dragging = false;
	using services = createTestEditorServices();
	const control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, {
		activate: () => undefined,
		preview: (input) => previews.push(input),
		close: () => undefined,
		pinEditor: input => keptEditors.push(input),
		unstickEditor: () => undefined,
		startDrag: () => {
			dragging = true;
		},
		isDragging: () => dragging,
		drop: (target, position) => drops.push({ target, position }),
		dropExternal: () => undefined,
		endDrag: () => {
			dragging = false;
		},
	} satisfies EditorTabsDelegate, new EditorGroupModel());
	const first = input("first");
	const second = input("second");
	control.setEditors([descriptor(first), descriptor(second)], first);
	const tabs = control.domNode.querySelectorAll<HTMLElement>(".ash-tab");
	const firstTab = tabs[0];
	const secondTab = tabs[1];
	assert.ok(firstTab);
	assert.ok(secondTab);
	assert.match(firstTab.querySelector('.ash-tab-label')?.getAttribute('aria-description') ?? '', /Pin Editor to pin/u);
	Object.defineProperty(secondTab, "getBoundingClientRect", {
		value: () => ({ left: 100, width: 100 }),
	});

	firstTab.dispatchEvent(dragEvent(dom.window, "dragstart"));
	secondTab.dispatchEvent(dragEvent(dom.window, "dragenter", 175, 100));
	secondTab.dispatchEvent(dragEvent(dom.window, "dragover", 175, 1700));
	assert.deepEqual(previews, [second]);
	assert.equal(secondTab.classList.contains(DndCssClasses.DropAfter), true);
	secondTab.dispatchEvent(dragEvent(dom.window, "drop", 175));

	assert.deepEqual(drops, [{ target: second, position: "after" }]);
	assert.equal(firstTab.querySelectorAll('.ash-tab-close-action').length, 1);
	assert.equal(firstTab.querySelector('[data-action-id="workbench.editor.toggleSticky"]'), null);
	const firstLabel = firstTab.querySelector<HTMLButtonElement>('.ash-tab-label');
	firstLabel?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
	firstLabel?.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
	assert.deepEqual(keptEditors, [first]);
	assert.equal(firstTab.classList.contains(DndCssClasses.Dragging), false);
	control.dispose();
	dom.window.close();
});

test("MultiEditorTabsControl forwards external resource drops to the target tab", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const drops: Array<{ target: IResourceEditorInput | undefined; position: "before" | "after"; }> = [];
	using services = createTestEditorServices();
	const control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, {
		activate: () => undefined,
		preview: () => undefined,
		close: () => undefined,
		pinEditor: () => undefined,
		unstickEditor: () => undefined,
		startDrag: () => undefined,
		isDragging: () => false,
		drop: () => undefined,
		dropExternal: (_event, target, position) => drops.push({ target, position }),
		endDrag: () => undefined,
	} satisfies EditorTabsDelegate, new EditorGroupModel());
	const target = input("target");
	control.setEditors([descriptor(target)], target);
	const tab = control.domNode.querySelector<HTMLElement>(".ash-tab");
	assert.ok(tab);
	tab.getBoundingClientRect = () => ({ left: 100, width: 100 } as DOMRect);
	const dataTransfer = externalDataTransfer();

	tab.dispatchEvent(dragEvent(dom.window, "dragover", 125, undefined, dataTransfer));
	assert.equal(dataTransfer.dropEffect, "copy");
	tab.dispatchEvent(dragEvent(dom.window, "drop", 125, undefined, dataTransfer));

	assert.deepEqual(drops, [{ target, position: "before" }]);
	control.dispose();
	dom.window.close();
});

test("Connected tab clipping follows the visible tab strip", () => {
	const dom = new JSDOM("<!doctype html><body><div id='strip'><div id='tab'></div></div></body>");
	const strip = dom.window.document.getElementById("strip")!;
	const tab = dom.window.document.getElementById("tab")!;
	const bounds = {
		tab,
		overflowEdge: strip,
		fillLeft: 120,
		fillRight: 220,
		viewportLeft: 0,
		viewportRight: 100,
		shoulderExtent: 6,
	};

	updateConnectedTabClipping(bounds, 80);
	assert.equal(tab.classList.contains("connected-tab-right-clipped"), true);
	assert.equal(strip.classList.contains("connected-tab-right-clipped"), true);
	updateConnectedTabClipping(bounds, 130);
	assert.equal(tab.classList.contains("connected-tab-left-clipped"), true);
	assert.equal(tab.classList.contains("connected-tab-right-clipped"), false);
	updateConnectedTabClipping(bounds, 230);
	assert.equal(tab.classList.contains("connected-tab-hidden"), true);
	assert.equal(strip.classList.contains("connected-tab-left-clipped"), false);

	dom.window.close();
});

test("EditorTitleControl switches tab modes and breadcrumbs from configuration", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const configuration = new InMemoryConfigurationService();
	const group = new EditorGroupModel();
	using services = createTestEditorServices(configuration);
	const control = services.createInstance(EditorTitleControl, dom.window.document.body, inertDelegate, group, undefined, configuration, undefined, undefined, undefined, undefined, undefined);
	const first = input("folder/first");
	const second = input("folder/second");
	group.openEditor(first);
	group.openEditor(second);
	control.setEditors([descriptor(first), descriptor(second)], second);

	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 2);
	const firstTab = control.domNode.querySelector('.ash-tab');
	const ordinaryRow = control.domNode.querySelector('.ash-ordinary-editor-tabs-row')!;
	const stickyRow = control.domNode.querySelector('.ash-sticky-editor-tabs-row')!;
	const close = firstTab!.querySelector<HTMLButtonElement>('.ash-tab-primary-action button')!;
	close.focus();
	assert.equal(ordinaryRow.classList.contains('ash-connected-editor-tabs'), true);
	await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, 'pill');
	assert.equal(ordinaryRow.classList.contains('ash-connected-editor-tabs'), false);
	assert.equal(control.domNode.querySelector('.ash-tab'), firstTab);
	assert.equal(dom.window.document.activeElement, close);
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-inset'), true);
	await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-flush'), true);
	assert.equal(control.domNode.querySelector('.ash-tab'), firstTab);
	await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'modern');
	assert.equal(control.domNode.querySelector('.ash-tab-list')?.classList.contains('ash-tab-list-inset'), true);
	assert.equal(ordinaryRow.classList.contains('ash-connected-editor-tabs'), false);
	await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, 'connected');
	assert.equal(ordinaryRow.classList.contains('ash-connected-editor-tabs'), true);
	assert.match(control.domNode.querySelector(".ash-editor-breadcrumbs")?.textContent ?? "", /folder.*second/);
	assert.equal(control.height, 57);
	group.stick(first);
	control.setEditors([{ ...descriptor(first), sticky: true }, descriptor(second)], second);
	assert.equal(control.height, 92);
	assert.equal(control.domNode.querySelector('.ash-sticky-editor-tabs-row .ash-tab-label')?.textContent, 'folder/first');
	assert.deepEqual([stickyRow, ordinaryRow].map(row => row.classList.contains('ash-connected-editor-tabs')), [false, true]);
	await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, 'pill');
	assert.deepEqual([stickyRow, ordinaryRow].map(row => row.classList.contains('ash-connected-editor-tabs')), [false, false]);
	await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, 'connected');
	group.unstick(first);
	control.setEditors([descriptor(first), descriptor(second)], second);
	assert.equal(control.height, 57);
	assert.equal((control.domNode.querySelector('.ash-sticky-editor-tabs-row') as HTMLElement).hidden, true);
	assert.equal(ordinaryRow.classList.contains('ash-connected-editor-tabs'), true);

	await configuration.updateValue(EditorTabsModeConfiguration, "single");
	assert.equal(control.height, 57);
	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 1);
	assert.equal(control.domNode.querySelector(".ash-tab-label")?.textContent, "folder/second");

	await configuration.updateValue(EditorTabsModeConfiguration, "none");
	assert.equal(control.domNode.querySelectorAll(".ash-tab").length, 0);
	await configuration.updateValue(BreadcrumbsEnabledConfiguration, false);
	assert.equal((control.domNode.querySelector(".ash-editor-breadcrumbs") as HTMLElement).hidden, true);
	assert.equal(control.height, 35);

	control.dispose();
	configuration.dispose();
	dom.window.close();
});

test('editor tab width changes reach both rows and preserve focused actions', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = new InMemoryConfigurationService();
		using services = createTestEditorServices(configuration);
		const group = new EditorGroupModel();
		const first = input('first');
		const second = input('second');
		group.openEditor(first);
		group.openEditor(second);
		group.stick(first);
		using control = services.createInstance(EditorTitleControl, dom.window.document.body, inertDelegate, group, undefined, configuration, undefined, undefined, undefined, undefined, undefined);
		control.setEditors([{ ...descriptor(first), sticky: true }, descriptor(second)], second);
		const lists = [...control.domNode.querySelectorAll<HTMLElement>('.ash-tab-list')];
		const action = control.domNode.querySelector<HTMLButtonElement>('.ash-tab-primary-action button')!;
		action.focus();
		await configuration.updateValue(EditorTabSizingFixedMinWidthConfiguration, 90);
		await configuration.updateValue(EditorTabSizingFixedMaxWidthConfiguration, 220);
		for (const mode of ['fixed', 'shrink', 'fit']) {
			await configuration.updateValue(EditorTabSizingConfiguration, mode);
			assert.equal(control.domNode.querySelector('.ash-tab-primary-action button'), action);
			assert.equal(dom.window.document.activeElement, action);
			assert.deepEqual(lists.map(list => ({ mode: list.classList.contains(`ash-tab-list-sizing-${mode}`), min: list.style.getPropertyValue('--ash-tab-list-fixed-min-width'), max: list.style.getPropertyValue('--ash-tab-list-fixed-max-width') })), lists.map(() => ({ mode: true, min: mode === 'fixed' ? '90px' : '', max: mode === 'fixed' ? '220px' : '' })));
		}
	} finally {
		dom.window.close();
	}
});

test("EditorTitleControl follows nested document symbols and opens outline selection", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using configuration = new InMemoryConfigurationService();
	using model = new TextModel("function Alpha\n  member Beta", { languageId: "typescript" });
	using features = new LanguageFeaturesService();
	const outerRange = new Range(1, 1, 2, 14);
	const innerRange = new Range(2, 3, 2, 14);
	const inner: LanguageDocumentSymbol = { name: "Beta", kind: "method", range: innerRange, selectionRange: innerRange };
	const outer: LanguageDocumentSymbol = { name: "Alpha", kind: "function", range: outerRange, selectionRange: outerRange, children: [inner] };
	using provider = features.documentSymbolProvider.register("*", { provideDocumentSymbols: () => [outer] });
	const cursorChanges = new Emitter<void>();
	let position = new Position(2, 5);
	let chosen: LanguageDocumentSymbol | undefined;
	let revealed: Range | undefined;
	const pane = {
		getControl: () => ({ getModel: () => model, getPosition: () => position, onDidChangeCursorSelection: cursorChanges.event }),
		revealRange: (range: Range) => { revealed = range; },
	} as unknown as IEditorPane;
	const group = new EditorGroupModel();
	using services = createTestEditorServices(configuration);
	const control = services.createInstance(EditorTitleControl, dom.window.document.body, inertDelegate, group, undefined, configuration, undefined, undefined, undefined, features,
		(_symbols: readonly LanguageDocumentSymbol[], selected: LanguageDocumentSymbol, reveal: (range: Range) => void) => { chosen = selected; reveal(selected.selectionRange); });
	const resource = input("folder/symbols.ts");
	group.openEditor(resource);
	control.setEditors([descriptor(resource)], resource, pane);
	for (let attempt = 0; attempt < 50 && !control.domNode.textContent?.includes("Beta"); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.match(control.domNode.querySelector(".ash-editor-breadcrumbs")?.textContent ?? "", /symbols\.ts.*Alpha.*Beta/u);
	const buttons = control.domNode.querySelectorAll<HTMLButtonElement>(".ash-editor-breadcrumbs button");
	buttons[buttons.length - 1]?.click();
	assert.equal(chosen?.name, "Beta");
	assert.deepEqual(revealed, innerRange);

	position = new Position(1, 5);
	cursorChanges.fire();
	assert.doesNotMatch(control.domNode.querySelector(".ash-editor-breadcrumbs")?.textContent ?? "", /Beta/u);
	await configuration.updateValue(BreadcrumbsFilePathConfiguration, "off");
	assert.doesNotMatch(control.domNode.querySelector(".ash-editor-breadcrumbs")?.textContent ?? "", /symbols\.ts/u);
	await configuration.updateValue(BreadcrumbsSymbolPathConfiguration, "off");
	assert.equal(control.height, 35);
	control.dispose();
	cursorChanges.dispose();
	dom.window.close();
});

const inertDelegate: EditorTabsDelegate = {
	activate: () => undefined,
	preview: () => undefined,
	close: () => undefined,
	pinEditor: () => undefined,
	unstickEditor: () => undefined,
	startDrag: () => undefined,
	isDragging: () => false,
	drop: () => undefined,
	dropExternal: () => undefined,
	endDrag: () => undefined,
};

suite('Editor tab label format', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('unique filenames omit paths and duplicate names remain distinct across pinned rows', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = createTestEditorServices();
			const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
			workspace.updateWorkspace({ id: 'labels', uri: URI.file('/work/ash') });
			const group = new EditorGroupModel();
			const first = { resource: URI.file('/work/ash/client/src/index.ts') };
			const second = { resource: URI.file('/work/ash/server/src/index.ts') };
			const unique = { resource: URI.file('/work/ash/.cursorignore') };
			const tab = (input: IResourceEditorInput) => ({ ...descriptor(input), instanceId: input.resource.path, tabId: `${input.resource.path}-tab`, panelId: `${input.resource.path}-panel` });
			group.openEditor(first);
			group.openEditor(unique);
			using control = services.createInstance(EditorTitleControl, dom.window.document.body, inertDelegate, group, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
			control.setEditors([tab(first), tab(unique)], first);
			const names = () => [...control.domNode.querySelectorAll('.ash-tab-label')].map(label => label.textContent?.replaceAll('\\', '/'));
			assert.deepEqual(names(), ['index.ts', '.cursorignore']);
			group.openEditor(second);
			control.setEditors([tab(first), tab(unique), tab(second)], second);
			assert.deepEqual(names(), ['index.tsclient/…', '.cursorignore', 'index.tsserver/…']);
			assert.deepEqual([...control.domNode.querySelectorAll('.ash-tab-label')].map(label => label.getAttribute('aria-label')?.replaceAll('\\', '/')), ['index.ts, client/…', '.cursorignore', 'index.ts, server/…']);
			group.stick(first);
			control.setEditors([{ ...tab(first), sticky: true }, tab(unique), tab(second)], second);
			assert.deepEqual(names(), ['index.tsclient/…', '.cursorignore', 'index.tsserver/…']);
			group.closeEditor(second);
			control.setEditors([{ ...tab(first), sticky: true }, tab(unique)], first);
			assert.deepEqual(names(), ['index.ts', '.cursorignore']);
		} finally {
			dom.window.close();
		}
	});

	test('workspace-root files, remote hosts and separate groups retain their file identities', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = createTestEditorServices();
			const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
			workspace.updateWorkspace({ id: 'labels', uri: URI.file('/work/ash') });
			const group = new EditorGroupModel();
			const rootFile = { resource: URI.file('/work/ash/index.ts') };
			const nestedFile = { resource: URI.file('/work/ash/src/index.ts') };
			const tab = (input: IResourceEditorInput) => ({ ...descriptor(input), instanceId: input.resource.toString(), tabId: `${input.resource.toString()}-tab`, panelId: `${input.resource.toString()}-panel` });
			group.openEditor(rootFile);
			group.openEditor(nestedFile);
			using control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, group);
			control.setEditors([tab(rootFile), tab(nestedFile)], nestedFile);
			assert.deepEqual([...control.domNode.querySelectorAll('.ash-tab-label')].map(label => label.textContent?.replaceAll('\\', '/')), ['index.ts./', 'index.tssrc']);
			const otherGroup = new EditorGroupModel();
			otherGroup.openEditor(rootFile);
			using other = services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, otherGroup);
			other.setEditors([{ ...tab(rootFile), tabId: 'other-group-index-tab', panelId: 'other-group-index-panel' }], rootFile);
			assert.equal(other.domNode.querySelector('.ash-tab-label')?.textContent, 'index.ts');
			workspace.updateWorkspace({ id: 'empty', folders: [] });
			const remoteGroup = new EditorGroupModel();
			const remotes = ['client', 'server'].map(host => ({ resource: URI.parse(`vscode-remote://ssh-remote+${host}/work/index.ts`) }));
			for (const remote of remotes) { remoteGroup.openEditor(remote); }
			using remote = services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, remoteGroup);
			remote.setEditors(remotes.map(tab), remotes[1]);
			const names = [...remote.domNode.querySelectorAll('.ash-tab-label')].map(label => label.getAttribute('aria-label'));
			assert.match(names[0]!, /ssh-remote\+client/u);
			assert.match(names[1]!, /ssh-remote\+server/u);
		} finally {
			dom.window.close();
		}
	});

	test('format changes preserve the tab, focus, selection and dirty state and follow workspace roots', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using configuration = new InMemoryConfigurationService();
			using services = createTestEditorServices(configuration);
			const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
			workspace.updateWorkspace({ id: 'labels', uri: URI.file('/work/ash') });
			const group = new EditorGroupModel();
			const file = { resource: URI.file('/work/ash/client/src/index.ts') };
			group.openEditor(file);
			using control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, group);
			control.setEditors([{ ...descriptor(file), isDirty: true }], file, new Set([descriptor(file).instanceId]));
			const tab = control.domNode.querySelector<HTMLButtonElement>('.ash-tab-label')!;
			tab.focus();
			for (const [format, description] of [['short', 'src'], ['medium', 'client/src'], ['long', '/work/ash/client/src'], ['default', '']] as const) {
				await configuration.updateValue(EditorLabelFormatConfiguration, format);
				assert.equal(tab.textContent?.replaceAll('\\', '/'), `index.ts${description}`);
				assert.equal(control.domNode.querySelector('.ash-tab-label'), tab);
				assert.equal(dom.window.document.activeElement, tab);
				assert.match(tab.getAttribute('aria-label')!, /unsaved changes$/u);
				assert.equal(tab.getAttribute('aria-selected'), 'true');
			}
			await configuration.updateValue(EditorLabelFormatConfiguration, 'medium');
			await assert.rejects(configuration.updateValue(EditorLabelFormatConfiguration, 'never'), /Invalid editor label format/u);
			await assert.rejects(configuration.updateValue(EditorLabelFormatConfiguration, false), /Invalid editor label format/u);
			assert.equal(configuration.getValue(EditorLabelFormatConfiguration), 'medium');
			workspace.updateWorkspace({ id: 'new-root', uri: URI.file('/work') });
			assert.equal(tab.textContent?.replaceAll('\\', '/'), 'index.tsash/client/src');
			const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
			setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
			const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(EditorLabelFormatConfiguration)!;
			assert.equal(setting.setting?.valueType, 'select');
			assert.throws(() => setting.parse('never'), /无效的编辑器标签格式/u);
			assert.deepEqual([setting.defaultValue, setting.setting?.title, setting.setting?.valueType === 'select' ? setting.setting.options.map(option => option.label) : undefined], ['default', '工作台 › 编辑器：标签格式', ['默认', '父目录', '相对路径', '绝对路径']]);
		} finally {
			resetNlsResolver();
			dom.window.close();
		}
	});
});

function input(name: string): IResourceEditorInput {
	return { resource: URI.parse(`untitled:/${name}`), label: name };
}

function descriptor(input: IResourceEditorInput): { readonly instanceId: string; readonly input: IResourceEditorInput; readonly panelId: string; readonly tabId: string; } {
	return { instanceId: `${input.label}-instance`, input, panelId: `${input.label}-panel`, tabId: `${input.label}-tab` };
}

function dragEvent(targetWindow: { readonly Event: typeof Event; }, type: string, clientX = 0, timeStamp?: number, dataTransfer?: DataTransfer): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
	if (dataTransfer) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	return event;
}

function externalDataTransfer(): DataTransfer {
	return {
		types: ["text/uri-list"],
		dropEffect: "none",
		getData: () => "file:///C:/project/dropped.ts",
	} as unknown as DataTransfer;
}

test('Editor tabs require the window resource label service before rendering', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, new EditorGroupModel()), /Unknown service: resourceLabelService/u);
		assert.equal(dom.window.document.body.childElementCount, 0);
	} finally {
		dom.window.close();
	}
});

suite('Editor resource decorations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tabs update file decorations and their accessible names without losing dirty state or focus', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		using changes = new Emitter<readonly URI[]>();
		const file = input('file.ts');
		let data: IDecorationData | undefined = { letter: 'M', color: 'description.foreground', tooltip: 'Modified' };
		using provider = services.get(IDecorationsService).registerDecorationsProvider({ label: 'Test', onDidChange: changes.event, provideDecorations: () => data });
		using control = services.createInstance(MultiEditorTabsControl, dom.window.document.body, inertDelegate, new EditorGroupModel());
		control.setEditors([descriptor(file)], file);
		const tab = control.domNode.querySelector<HTMLButtonElement>('.ash-tab-label')!;
		assert.equal(tab.getAttribute('aria-label'), 'file.ts, Modified');
		tab.focus();
		control.setEditors([{ ...descriptor(file), isDirty: true }], file);
		assert.equal(tab.getAttribute('aria-label'), 'file.ts, Modified, unsaved changes');
		assert.equal(dom.window.document.activeElement, tab);
		data = { letter: 'D', strikethrough: true, tooltip: 'Deleted' };
		changes.fire([file.resource]);
		assert.equal(tab.getAttribute('aria-label'), 'file.ts, Deleted, unsaved changes');
		assert.equal(control.domNode.querySelector('.ash-tab-label'), tab);
		assert.equal(dom.window.document.activeElement, tab);
		provider.dispose();
		assert.equal(tab.getAttribute('aria-label'), 'file.ts, unsaved changes');
		dom.window.close();
	});
});
