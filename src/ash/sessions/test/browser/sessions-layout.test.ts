import { createDesktopEditorTestServices, registerDesktopDetailsTestServices } from './desktopEditorTestServices.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { Orientation } from '../../../base/browser/ui/sash/sash.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { createTestComponentServices, createTestEditorServices, registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../workbench/services/notification/test/common/testNotificationService.js';
import { sessionsPartIds } from '../../common/layoutConstants.js';
import { Position, positionToString } from '../../../workbench/services/layout/browser/layoutService.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../base/browser/dom.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { Dimension } = await import('../../../base/browser/dom.js');
const { Part } = await import('../../../workbench/browser/part.js');
const { WorkbenchWindowBarHeight } = await import('../../../workbench/browser/parts/workbenchPartDimensions.js');
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
const { IStorageService, WillSaveStateReason, StorageScope } = await import('../../../platform/storage/common/storage.js');
const { InstantiationService } = await import('../../../platform/instantiation/common/instantiationService.js');
const { ILayoutService } = await import('../../../platform/layout/browser/layoutService.js');
const { DesktopExistingSessionStrategy } = await import('../../contrib/layout/browser/desktop/desktopExistingSessionStrategy.js');
const { DesktopMainEditorPart } = await import('../../browser/parts/desktopEditorPart.js');
const { DesktopWorkbenchLayout } = await import('../../../sessions/browser/desktopWorkbench.js');
const { SessionsModernUIContribution } = await import('../../../sessions/contrib/modernUI/browser/modernUI.contribution.js');
const { SessionsConfiguration } = await import('../../../sessions/common/configuration.js');
const { WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { TestConfigurationService: WorkbenchConfigurationService } = await import('../../../workbench/services/configuration/test/common/testServices.js');

type SessionsPartId = import('../../common/layoutConstants.js').SessionsPartId;
type WorkbenchPartInstance = import('../../../workbench/browser/part.js').Part;

class TestSessionsPart extends Part {
	public getTabsHeight(): number { return 35; }
	public contentInset = 0;
	public contentVisible = true;
	public setContentRightInset(inset: number): void { this.contentInset = inset; }
	public setEditorContentVisible(visible: boolean): void { this.contentVisible = visible; }
	readonly layouts: import('../../../base/browser/dom.js').Dimension[] = [];

	constructor(readonly id: SessionsPartId, container: HTMLElement) {
		const services = createTestComponentServices(undefined, undefined, container.ownerDocument);
		super(container, id, services.get(IThemeService), services.get(IStorageService));
		this._register(services);
	}

	override layout(dimension: import('../../../base/browser/dom.js').Dimension): void {
		this.layouts.push(new Dimension(dimension.width, dimension.height));
		super.layout(dimension);
	}

	override get minimumWidth(): number {
		if (this.id === 'sidebar') return 170;
		if (this.id === 'sessions') return 320;
		if (this.id === 'auxiliarybar') return 270;
		if (this.id === 'editor') return 300;
		return 0;
	}

	override get maximumWidth(): number {
		return Number.POSITIVE_INFINITY;
	}

	override get minimumHeight(): number {
		return this.id === 'titlebar' ? WorkbenchWindowBarHeight : 0;
	}
	override get maximumHeight(): number {
		return this.id === 'titlebar' ? WorkbenchWindowBarHeight : Number.POSITIVE_INFINITY;
	}
}

class TestDesktopEditorPart extends DesktopMainEditorPart {
	public retain(resource: import('../../../base/common/lifecycle.js').IDisposable): void { this._register(resource); }
}

test('opening Files retains one owned AuxiliaryBarPart without creating an editor input', async () => {
	const { EditorPaneRegistry } = await import('../../../workbench/browser/editor.js');
	const { ViewPane } = await import('../../../workbench/browser/parts/views/viewPane.js');
	const { ViewContainerLocation } = await import('../../../workbench/common/views.js');
	const { SyncDescriptor } = await import('../../../platform/instantiation/common/descriptors.js');
	using resources = new (await import('../../../base/common/lifecycle.js')).DisposableStore();
	using services = registerTestComponentServices(createTestEditorServices(), browserEnvironment.window.document);
	registerDesktopDetailsTestServices(resources, services);
	using registry = new EditorPaneRegistry();
	using editor = services.createInstance(DesktopMainEditorPart, browserEnvironment.window.document.body, { registry });
	let created = 0;
	class TestDetailsView extends ViewPane {
		constructor(container: HTMLElement, options: import('../../../workbench/browser/parts/views/viewPane.js').IViewPaneOptions) {
			super(container, options);
			created++;
		}
	}
	const auxiliary = editor.auxiliaryBar;
	const detailsStorage = services.get(IStorageService);
	detailsStorage.store('workbench.auxiliarybar.activeViewContainer', 'window.properties', StorageScope.WORKSPACE,
		(await import('../../../platform/storage/common/storage.js')).StorageTarget.MACHINE);
	using registration = auxiliary.registerViewContainer({ id: 'test.details', title: 'Details', location: ViewContainerLocation.AuxiliaryBar }, [
		{ id: 'test.details.view', title: 'Details', ctorDescriptor: new SyncDescriptor(TestDetailsView) },
	]);
	assert.equal(created, 0);
	const group = editor.activeGroup;
	await editor.openFiles();
	assert.deepEqual(group.inputs, []);
	assert.equal(group.activePane, undefined);
	assert.equal(group.domNode.querySelector('[role="tab"]'), null);
	assert.equal(editor.detailsOpen, true);
	assert.equal(editor.auxiliaryBar, auxiliary);
	assert.equal(detailsStorage.get('workbench.auxiliarybar.activeViewContainer', StorageScope.WORKSPACE), 'window.properties');
	assert.equal(created, 1);
	await editor.openFiles();
	assert.equal(created, 1);
	assert.equal(auxiliary.domNode.closest('.ash-editor-group'), null);
	const saved = editor.saveWorkingSet('legacy-files', [editor.pageGroupId]);
	await editor.applyWorkingSet({
		...saved, groups: saved.groups.map(group => ({
			...group, activeEditorIndex: 0,
			editors: [{ input: { typeId: 'sessions.editorInput.files', value: {} }, paneId: 'ash.sessions.emptyFileEditor', preview: false }],
		}))
	}, { preserveGroups: [editor.pageGroupId] });
	assert.deepEqual(editor.activeGroup.inputs, []);
	editor.hideDetails();
	assert.equal(editor.detailsOpen, false);
	assert.equal(editor.auxiliaryBar, auxiliary);
});

test('Desktop editor retains one tab-and-actions row above editor-only breadcrumbs', async () => {
	const { URI } = await import('../../../base/common/uri.js');
	const { EditorPaneRegistry } = await import('../../../workbench/browser/editor.js');
	const { EditorPane } = await import('../../../workbench/browser/parts/editor/editorPane.js');
	const { IConfigurationService } = await import('../../../platform/configuration/common/configuration.js');
	using services = registerTestComponentServices(createTestEditorServices(), browserEnvironment.window.document);
	const configuration = services.get(IConfigurationService);
	using registry = new EditorPaneRegistry();
	registry.registerEditorPane({
		id: 'test.header', name: 'Header fixture',
		canOpen: () => 1,
		create: () => new class extends EditorPane {
			readonly id = 'test.header';
			async setInput(): Promise<void> { }
			clearInput(): void { }
			layout(): void { }
			focus(): void { }
		}('test.header', services.get(IThemeService), services.get(IStorageService)),
	});
	using editor = services.createInstance(DesktopMainEditorPart, browserEnvironment.window.document.body, { registry, configurationService: configuration });
	editor.layout(new Dimension(800, 600));
	const title = editor.activeGroup.domNode.querySelector<HTMLElement>('.ash-editor-title-control')!;
	const header = title.querySelector<HTMLElement>('.ash-editor-group-header')!;
	const foreignHeader = browserEnvironment.window.document.createElement('div');
	foreignHeader.className = 'ash-editor-group-header';
	assert.equal(header.hidden, false);
	assert.equal(editor.getTabsHeight(), 32);
	const input = { resource: URI.file('/fixture/sample.txt') };
	await editor.openEditor(input, { pinned: true });
	assert.ok(header.querySelector('[role="tab"]'));
	assert.ok(header.querySelector('.ash-editor-title-actions'));
	const breadcrumbs = title.querySelector<HTMLElement>(':scope > .ash-editor-breadcrumbs')!;
	assert.equal(breadcrumbs.hidden, false);
	assert.equal(header.nextElementSibling, breadcrumbs);
	assert.deepEqual((editor.activeGroup as import('../../../workbench/browser/parts/editor/editorGroupView.js').EditorGroupView).titleHeight, { offset: 32, total: 54 });
	editor.setContentRightInset(220);
	assert.equal(title.style.getPropertyValue('--ash-editor-content-right-inset'), '220px');
	const second = { resource: URI.file('/fixture/second.txt') };
	await editor.openEditor(second, { pinned: true });
	editor.activeGroup.stickEditor(input);
	assert.equal(editor.getTabsHeight(), 64);
	let layouts = 0;
	using layoutListener = editor.onDidLayout(() => { layouts++; });
	await configuration.updateValue('workbench.editor.showTabs', 'single');
	assert.ok(layouts > 0, 'Tab mode changes must update the surrounding docked layout');
	assert.equal(editor.getTabsHeight(), 32);
	await configuration.updateValue('workbench.editor.showTabs', 'multiple');
	assert.equal(editor.getTabsHeight(), 64);
	await editor.activeGroup.closeEditor(second);
	await editor.activeGroup.closeEditor(input);
	assert.equal(header.hidden, false);
	assert.equal(title.hidden, false);
	assert.equal(breadcrumbs.hidden, true);
	assert.equal(editor.getTabsHeight(), 32);
});

function createParts(ownerDocument: Document, storage?: import('../../../platform/storage/common/storage.js').IStorageService): Map<SessionsPartId, WorkbenchPartInstance> {
	const parts: Map<SessionsPartId, WorkbenchPartInstance> = new Map(sessionsPartIds.filter(id => id !== 'editor').map(partId => [partId, new TestSessionsPart(partId, ownerDocument.body)]));
	const services = registerTestComponentServices(createTestEditorServices(undefined, undefined, ownerDocument, storage), ownerDocument);
	const editor = services.createInstance(TestDesktopEditorPart, ownerDocument.body, {});
	editor.retain(services);
	parts.set('editor', editor);
	return parts;
}

test('Sessions Grid follows viewport resize synchronously and retains fractional root dimensions', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector('main')!;
	const parts = createParts(dom.window.document);
	let bounds = { width: 1_200.2, height: 800.8 };
	container.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, bounds.width, bounds.height);
	Object.defineProperties(container, {
		clientWidth: { get: () => Math.round(bounds.width) },
		clientHeight: { get: () => Math.round(bounds.height) },
	});
	try {
		using layout = createLayout(container, parts);
		assert.deepEqual(layout.mainContainerDimension, new Dimension(1_200.2, 800.8));
		for (const next of [
			{ width: 1_000.6, height: 700.4 },
			{ width: 1_300.2, height: 900.8 },
		]) {
			bounds = next;
			dom.window.dispatchEvent(new dom.window.Event('resize'));
			assert.deepEqual(layout.mainContainerDimension, new Dimension(next.width, next.height));
			assert.equal(layout.getPartSize('titlebar').width, next.width);
		}
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Code tools own independent EditorParts and tool movement and hiding retain every pane', async () => {
	const { URI } = await import('../../../base/common/uri.js');
	const { EditorPaneRegistry } = await import('../../../workbench/browser/editor.js');
	const { EditorPane } = await import('../../../workbench/browser/parts/editor/editorPane.js');
	const { TerminalEditorInput } = await import('../../../workbench/contrib/terminal/browser/terminalEditorInput.js');
	const { GroupDirection } = await import('../../../workbench/services/editor/common/editorGroupsService.js');
	using services = registerTestComponentServices(createTestEditorServices(), browserEnvironment.window.document);
	using registry = new EditorPaneRegistry();
	let created = 0;
	for (const id of ['test.tools', TerminalEditorInput.ID]) registry.registerEditorPane({
		id, name: 'Tool fixture', canOpen: () => 1, create: () => {
			created++;
			return new class extends EditorPane {
				readonly id = id;
				async setInput(): Promise<void> { }
				clearInput(): void { }
				layout(): void { }
				focus(): void { }
			}(id, services.get(IThemeService), services.get(IStorageService));
		}
	});
	using hosts = createDesktopEditorTestServices(services, { registry });
	const { editor, area } = hosts;
	editor.layout(new Dimension(1200, 900));
	const file = { resource: URI.file('/fixture/sample.txt') };
	const terminal = new TerminalEditorInput(URI.parse('vscode-terminal:/fixture/1'));
	await editor.openEditor(file, { pinned: true });
	const fileGroup = editor.activeGroup;
	await editor.openEditor(terminal, { pinned: true });
	const terminalGroup = editor.activeGroup;
	const terminalPane = terminalGroup.activePane;
	await editor.openEditor({ resource: URI.parse('ash-browser:/fixture') }, { pinned: true });
	await editor.openEditor({ resource: URI.parse('ash-session-changes:/fixture') }, { pinned: true });
	assert.equal(editor.groups.filter(group => editor.isGroupVisible(group.id)).length, 4);
	assert.equal(created, 4);
	area.moveTool('terminal', 'files', Direction.Right);
	assert.equal(terminalGroup.activePane, terminalPane);
	assert.equal(terminalGroup.domNode.closest('[data-editor-tool]')?.getAttribute('data-editor-tool'), 'terminal');
	await editor.toggleToolEditors(input => input instanceof TerminalEditorInput);
	assert.equal(editor.isGroupVisible(terminalGroup.id), false);
	await editor.toggleToolEditors(input => input instanceof TerminalEditorInput);
	assert.equal(editor.isGroupVisible(terminalGroup.id), true);
	assert.equal(terminalGroup.activePane, terminalPane);
	assert.equal(created, 4);
	const before = area.saveLayout();
	editor.toggleMaximizeTool(terminalGroup.id);
	editor.toggleMaximizeTool(terminalGroup.id);
	assert.deepEqual(area.saveLayout(), before);
	const filePane = fileGroup.activePane;
	const otherGroups = editor.groups.filter(group => group !== fileGroup && editor.isGroupVisible(group.id));
	await editor.toggleFileEditors();
	assert.equal(editor.isGroupVisible(fileGroup.id), false);
	assert.ok(otherGroups.every(group => editor.isGroupVisible(group.id)));
	assert.equal(fileGroup.activePane, filePane);
	await editor.toggleFileEditors();
	assert.equal(editor.isGroupVisible(fileGroup.id), true);
	assert.equal(fileGroup.activePane, filePane);
	assert.equal(created, 4);
	const mixed = { resource: URI.file('/fixture/mixed.txt') };
	await editor.openEditor(mixed, { pinned: true }, { groupId: terminalGroup.id });
	await editor.toggleFileEditors();
	assert.equal(editor.isGroupVisible(fileGroup.id), false);
	assert.equal(editor.isGroupVisible(terminalGroup.id), true);
	assert.equal(terminalGroup.activeInput, terminal);
	assert.ok(fileGroup.inputs.includes(mixed));
	assert.ok(!terminalGroup.inputs.includes(mixed));
	assert.ok(otherGroups.every(group => editor.isGroupVisible(group.id)));

	// The right tool must grow past the default width when visible group minimums
	// no longer fit, including after changing the orientation of a tool workspace.
	const parts = createParts(browserEnvironment.window.document);
	const oldEditor = parts.get('editor')!;
	parts.set('editor', area);
	try {
		using layout = createLayout(browserEnvironment.window.document.body, parts, { initialDimension: new Dimension(1_245, 890) });
		layout.showPart('editor');
		layout.resizePart('editor', new Dimension(300, 800));
		const extraTerminalGroup = editor.addGroup(terminalGroup.id, Direction.Right);
		editor.setGroupVisible(extraTerminalGroup.id, true);
		area.moveTool('terminal', 'changes', Direction.Right);
		assert.ok(area.minimumWidth > 300);
		assert.ok(layout.getPartSize('editor').width >= area.minimumWidth);
		const wide = new Dimension(1_600, 890);
		layout.layout(wide);
		const arranged = area.saveLayout();
		const terminalEditors = terminalGroup.inputs.slice();
		layout.layout(new Dimension(980, 890));
		assert.equal(area.isToolVisible('terminal'), true);
		assert.equal(area.isToolVisible('changes'), true);
		assert.deepEqual(area.saveLayout(), arranged);
		const narrow = new Dimension(980, 390);
		layout.layout(narrow);
		assert.equal(layout.isPartVisible('sessions'), true);
		assert.equal(area.isToolVisible('terminal'), false);
		assert.equal(area.isToolVisible('changes'), true);
		assert.deepEqual(area.saveLayout(), arranged);
		await editor.toggleToolEditors(input => input instanceof TerminalEditorInput);
		assert.equal(area.isToolVisible('terminal'), true);
		assert.equal(area.isToolVisible('changes'), false);
		assert.deepEqual(terminalGroup.inputs, terminalEditors);
		assert.equal(terminalGroup.activePane, terminalPane);

		layout.layout(new Dimension(760, 390));
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.equal(layout.isPartRequested('sidebar'), true);
		assert.equal(layout.isPartVisible('sessions'), true);
		assert.equal(area.isToolVisible('terminal'), true);

		layout.layout(new Dimension(600, 890));
		assert.equal(layout.isPartVisible('sessions'), false);
		assert.equal(layout.isPartVisible('editor'), true);
		layout.showPart('sessions');
		assert.equal(layout.isPartVisible('sessions'), true);
		assert.equal(layout.isPartVisible('editor'), false);
		assert.equal(layout.isPartRequested('editor'), true);
		layout.layout(wide);
		assert.equal(layout.isPartVisible('editor'), true);
		assert.equal(area.isToolVisible('changes'), true);
		assert.equal(area.isToolVisible('terminal'), true);
		assert.deepEqual(area.saveLayout(), arranged);

		editor.hideTool(terminalGroup.id);
		assert.equal(area.minimumWidth, 300);
	} finally {
		oldEditor.dispose();
		for (const part of parts.values()) if (part !== area) part.dispose();
	}
});

test('opening a Code tool keeps the hidden active tool hidden', async () => {
	const { URI } = await import('../../../base/common/uri.js');
	const { BrowserViewUri } = await import('../../../platform/browserView/common/browserViewUri.js');
	const { EditorPaneRegistry } = await import('../../../workbench/browser/editor.js');
	const { EditorPane } = await import('../../../workbench/browser/parts/editor/editorPane.js');
	const { TerminalEditorInput } = await import('../../../workbench/contrib/terminal/browser/terminalEditorInput.js');
	using services = registerTestComponentServices(createTestEditorServices(), browserEnvironment.window.document);
	using registry = new EditorPaneRegistry();
	let created = 0;
	for (const id of ['test.independent-tools', TerminalEditorInput.ID]) registry.registerEditorPane({
		id, name: 'Tool fixture', canOpen: () => 1, create: () => {
			created++;
			return new class extends EditorPane {
				readonly id = id;
				async setInput(): Promise<void> { }
				clearInput(): void { }
				layout(): void { }
				focus(): void { }
			}(id, services.get(IThemeService), services.get(IStorageService));
		}
	});
	using hosts = createDesktopEditorTestServices(services, { registry });
	const { editor, area } = hosts;
	editor.layout(new Dimension(1200, 900));
	const terminal = new TerminalEditorInput(URI.parse('vscode-terminal:/fixture/1'));
	const browser = { resource: URI.from({ scheme: BrowserViewUri.scheme, path: '/fixture' }) };
	await editor.openEditor(terminal, { pinned: true });
	const terminalGroup = editor.activeGroup;
	const terminalPane = terminalGroup.activePane;
	await editor.toggleToolEditors(input => input instanceof TerminalEditorInput);
	assert.equal(editor.isGroupVisible(terminalGroup.id), false);
	await editor.openEditor(browser, { pinned: true });
	const browserGroup = editor.activeGroup;
	assert.deepEqual(editor.groups.filter(group => editor.isGroupVisible(group.id)).map(group => group.id), [browserGroup.id]);
	assert.equal(editor.isGroupVisible(terminalGroup.id), false);
	assert.equal(terminalGroup.activePane, terminalPane);
	await editor.toggleToolEditors(input => input.resource.scheme === BrowserViewUri.scheme);
	await editor.openEditor(terminal, { pinned: true });
	assert.equal(editor.isGroupVisible(browserGroup.id), false);
	assert.equal(editor.isGroupVisible(terminalGroup.id), true);
	assert.equal(terminalGroup.activePane, terminalPane);
	assert.equal(created, 2);
});

test('Sessions sidebar clamps at its minimum, snaps closed and restores from the window edge', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
		layout.layout(new Dimension(1_200, 800));
		const sidebar = parts.get('sidebar')!;
		const drag = (delta: number): void => {
			const split = sidebar.domNode.parentElement!.parentElement!.parentElement!;
			const sash = split.querySelector<HTMLElement>(':scope > .ash-sash')!;
			assert.ok(sash);
			sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 240 }));
			for (const type of ['pointermove', 'pointerup']) dom.window.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: 240 + delta }));
		};
		const visibility: boolean[] = [];
		using changes = layout.onDidChangePartVisibility(event => { if (event.partId === 'sidebar') visibility.push(event.visible); });
		const geometry: number[] = [];
		using geometryListener = layout.onDidLayoutMainContainer(() => geometry.push(layout.getPartSize('sidebar').width));
		drag(sidebar.minimumWidth - layout.getPartSize('sidebar').width - 20);
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.equal(layout.getPartSize('sidebar').width, sidebar.minimumWidth);
		assert.equal(geometry.at(-1), sidebar.minimumWidth, 'Sash layout reaches shared geometry consumers without a window resize');
		drag(-100);
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.equal(layout.state.sidebar.visible, false);
		assert.equal(parts.get('titlebar')!.domNode.style.getPropertyValue('--ash-sessions-titlebar-sidebar-width'), '0px');
		assert.equal(layout.isPartVisible('sidebar'), false, 'Rebuilding the Grid retains the snapped state');
		drag(110);
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.equal(layout.state.sidebar.visible, true);
		assert.ok(layout.getPartSize('sidebar').width >= sidebar.minimumWidth);
		assert.deepEqual(visibility, [false, true]);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions sidebar follows changing titlebar content constraints', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	class ConstrainedTitlebar extends TestSessionsPart {
		minimumSidebarWidth = 260;
		setSidebarMinimumWidth(width: number): void {
			this.minimumSidebarWidth = width;
			this.notifyConstraintsChanged();
		}
	}
	parts.get('titlebar')!.dispose();
	const titlebar = new ConstrainedTitlebar('titlebar', dom.window.document.body);
	parts.set('titlebar', titlebar);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
		layout.layout(new Dimension(1_200, 800));
		layout.resizePart('sidebar', new Dimension(180, 800));
		assert.equal(layout.getPartSize('sidebar').width, 260);
		titlebar.setSidebarMinimumWidth(330);
		assert.equal(layout.getPartSize('sidebar').width, 330);
		titlebar.setSidebarMinimumWidth(220);
		layout.resizePart('sidebar', new Dimension(180, 800));
		assert.equal(layout.getPartSize('sidebar').width, 220);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});





test('Custom Views cover retained content without changing its desired visibility and sizes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	parts.set('customview', new TestSessionsPart('customview', dom.window.document.body));
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		layout.showPart('editor'); layout.showPart('auxiliarybar');
		const previous = layout.state;
		layout.setCustomViewVisible(true);
		assert.equal(layout.isPanelMaximized(), false);
		assert.equal(layout.isPartVisible('customview'), true);
		for (const id of ['sessions', 'editor', 'auxiliarybar'] as const) assert.equal(layout.isPartVisible(id), false);
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.deepEqual(layout.state, previous);
		layout.hidePart('sidebar');
		assert.equal(layout.isPartVisible('sidebar'), false);
		layout.showPart('sidebar');
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.equal(layout.isPartVisible('customview'), true);
		layout.layout(new Dimension(1800, 1100));
		assert.equal(layout.state.editor.width, previous.editor.width);
		assert.equal(layout.state.auxiliarybar.width, previous.auxiliarybar.width);
		layout.setCustomViewVisible(false);
		assert.equal(layout.isPartVisible('customview'), false);
		for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar'] as const) assert.equal(layout.isPartVisible(id), true);
		assert.equal(layout.getPartSize('sidebar').width, previous.sidebar.width);
		layout.hidePart('sidebar');
		layout.setCustomViewVisible(true);
		layout.setCustomViewVisible(false);
		assert.equal(layout.isPartVisible('sidebar'), false, 'Returning from an independent page preserves a closed sidebar');
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions layout owns a fixed Sessions-first Part topology', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = createLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });

	layout.layout(new Dimension(1_200, 800));

	assert.deepEqual(layout.getPartSize('titlebar'), new Dimension(1_200, WorkbenchWindowBarHeight));
	assert.equal(container.querySelector('[data-part="activitybar"]'), null);
	assert.equal(Math.abs(layout.getPartSize('sidebar').width - 300) <= 1, true);
	assert.equal(Math.abs(layout.getPartSize('auxiliarybar').width - 340) <= 1, true);
	assert.equal(layout.getPartSize('sessions').height, 800 - WorkbenchWindowBarHeight);
	assert.equal(layout.getPartSize('sessions').width > 400, true);
	assert.equal(layout.isPartVisible('editor'), false);
	assert.equal(layout.state.editor.width, 600);
	assert.ok(container.querySelector("[data-part='editor']"));
	assert.ok(container.querySelector("[data-part='sessions']"));

	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions layout styles share edge-to-edge Part geometry and have an independent preference', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const configuration = new WorkbenchConfigurationService();
	const layout = createLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });
	const appearance = new SessionsModernUIContribution(container, configuration);
	const sessions = parts.get('sessions') as TestSessionsPart;
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.equal(container.dataset.layoutStyle, 'modern');
		assert.equal(container.classList.contains('modern-ui'), true);
		await configuration.updateValue(SessionsConfiguration.layoutStyle, 'flat');
		assert.equal(container.dataset.layoutStyle, 'flat');
		assert.deepEqual(sessions.layouts.at(-1), layout.getPartSize('sessions'));
		assert.equal(container.classList.contains('modern-ui'), false);
		assert.equal(configuration.getValue(WorkbenchConfiguration.layoutStyle), 'modern');
		assert.equal(layout.isPartVisible('auxiliarybar'), true);
		await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
		assert.equal(container.dataset.layoutStyle, 'flat');
		await configuration.updateValue(SessionsConfiguration.layoutStyle, 'modern');
		layout.hidePart('auxiliarybar');
		assert.deepEqual(sessions.layouts.at(-1), layout.getPartSize('sessions'));
		assert.equal(sessions.layouts.at(-1)?.height, 800 - WorkbenchWindowBarHeight);
	} finally {
		appearance.dispose();
		layout.dispose();
		configuration.dispose();
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions layout toggles the sidebar and auxiliary Part while keeping the primary Part visible', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = createLayout(container, parts, { initialDimension: new Dimension(1_000, 700) });
	const changes: Array<{ partId: SessionsPartId; visible: boolean; }> = [];
	const subscription = layout.onDidChangePartVisibility(change => changes.push(change));

	layout.layout(new Dimension(1_000, 700));
	const sidebarWidth = layout.getPartSize('sidebar').width;
	const sessionsWidth = layout.getPartSize('sessions').width;
	layout.hidePart('sidebar');
	assert.equal(layout.isPartVisible('sidebar'), false);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(layout.getPartSize('sessions').width > sessionsWidth, true);
	layout.showPart('sidebar');
	assert.equal(layout.isPartVisible('sidebar'), true);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	layout.showPart('auxiliarybar');
	layout.hidePart('auxiliarybar');

	assert.equal(layout.isPartVisible('auxiliarybar'), false);
	assert.equal(layout.getPartSize('sessions').width > 500, true);
	assert.equal(changes.at(-1)?.partId, 'auxiliarybar');
	assert.equal(changes.at(-1)?.visible, false);
	assert.throws(() => layout.hidePart('sessions'), /Required Sessions Part/);
	assert.throws(() => layout.hidePart('titlebar'), /Required Sessions Part/);

	subscription.dispose();
	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions layout temporarily hides the sidebar when the conversation needs the width', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	const wide = new Dimension(1_000, 700);
	const narrow = new Dimension(470, 700);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: wide });
		layout.hidePart('editor');
		layout.hidePart('auxiliarybar');
		layout.resizePart('sidebar', new Dimension(310, 700));
		const sidebarWidth = layout.getPartSize('sidebar').width;

		layout.layout(narrow);
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.equal(layout.isPartRequested('sidebar'), true);
		assert.equal(layout.state.sidebar.width, sidebarWidth);
		assert.equal(layout.getPartSize('sessions').width, narrow.width);

		layout.layout(wide);
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);

		layout.layout(narrow);
		layout.hidePart('sidebar');
		layout.layout(wide);
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.equal(layout.isPartRequested('sidebar'), false);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions compound composition changes lay out Parts once at the completed width', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_200, 800) });
	layout.layout(new Dimension(1_200, 800));
	const sessions = parts.get('sessions') as TestSessionsPart;
	sessions.layouts.length = 0;
	const completed: unknown[] = [];
	using subscription = layout.onDidLayoutMainContainer(dimension => completed.push(dimension));
	layout.updateParts(() => {
		layout.setPartAvailable('sidebar', false);
		// Composite selection can synchronously change composition inside the outer update.
		layout.updateParts(() => layout.setPartAvailable('auxiliarybar', false));
		assert.deepEqual(sessions.layouts, []);
		assert.deepEqual(completed, []);
	});
	assert.deepEqual(sessions.layouts, [new Dimension(1_200, 800 - WorkbenchWindowBarHeight)]);
	assert.deepEqual(completed, [new Dimension(1_200, 800)]);
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions entry changes preserve navigation width when replacing the only visible center', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		layout.layout(new Dimension(1600, 1000));
		layout.resizePart('sidebar', new Dimension(300, 1000));
		const titlebar = parts.get('titlebar')!.domNode;
		const titlebarHost = titlebar.parentElement;
		for (const sidebarAvailable of [true, false]) {
			layout.updateParts(() => {
				layout.setPartAvailable('sessions', false);
				layout.setPartAvailable('sidebar', sidebarAvailable);
				layout.setPrimaryPart('editor');
				layout.showPart('editor');
				if (!sidebarAvailable) { layout.hidePart('sidebar'); }
			});
			assert.equal(layout.state.sidebar.width, 300, 'Opening a product page retains the navigation width');
			assert.equal(titlebar.parentElement, titlebarHost, 'Mode changes retain the titlebar host and its animation state');
			layout.updateParts(() => {
				layout.setPrimaryPart('sessions');
				layout.setPartAvailable('sessions', true);
				layout.setPartAvailable('sidebar', true);
				layout.hidePart('editor');
				layout.showPart('sidebar');
			});
			assert.equal(layout.getPartSize('sidebar').width, 300, 'Returning to Chat retains the navigation width');
			assert.equal(titlebar.parentElement, titlebarHost, 'Returning to Chat retains the titlebar host');
		}
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions navigation collapses with the sidebar without reserving an icon rail', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = createLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });
	layout.hidePart('auxiliarybar');
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.equal(container.querySelector('[data-part="activitybar"]'), null);
		const expandedWidth = layout.getPartSize('sidebar').width;
		layout.hidePart('sidebar');
		assert.equal(layout.getPartSize('sessions').width, 1_200);
		layout.showPart('sidebar');
		assert.equal(layout.getPartSize('sidebar').width, expandedWidth);
	} finally {
		layout.dispose();
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions layout validates its complete Part set', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	const parts = createParts(dom.window.document);
	parts.delete('auxiliarybar');

	assert.throws(() => createLayout(container, parts), /missing Parts: auxiliarybar/);
	parts.set('auxiliarybar', new TestSessionsPart('auxiliarybar', dom.window.document.body));
	parts.delete('editor');
	assert.throws(() => createLayout(container, parts), /missing Parts: editor/);

	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions layout restores its profile-scoped geometry and auxiliary visibility', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const createStorage = () => new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'sessions',
		profileId: 'code-sessions',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const firstStorage = createStorage();
	const firstContainer = h(dom.window.document, 'main');
	const firstParts = createParts(dom.window.document, firstStorage);
	const first = createLayout(firstContainer, firstParts, { initialDimension: new Dimension(1_100, 700), storageService: firstStorage });
	first.layout(new Dimension(1_100, 700));
	first.resizePart('sidebar', new Dimension(320, first.getPartSize('sidebar').height));
	first.resizePart('auxiliarybar', new Dimension(360, first.getPartSize('auxiliarybar').height));
	first.hidePart('sidebar');
	first.hidePart('auxiliarybar');
	first.showPart('editor');
	first.showPart('auxiliarybar');
	first.resizePart('auxiliarybar', new Dimension(720, first.getPartSize('auxiliarybar').height));
	first.resizePart('editor', new Dimension(420, first.getPartSize('editor').height));
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.dispose();
	for (const part of firstParts.values()) part.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage();
	const restoredContainer = h(dom.window.document, 'main');
	const restoredParts = createParts(dom.window.document, restoredStorage);
	const restored = createLayout(restoredContainer, restoredParts, { initialDimension: new Dimension(1_100, 700), storageService: restoredStorage });
	restored.layout(new Dimension(1_100, 700));

	assert.equal(Math.abs(restored.getPartSize('sidebar').width - 320) <= 1, true);
	assert.equal(restored.isPartVisible('sidebar'), false);
	assert.equal(restoredContainer.querySelector('[data-part="activitybar"]'), null, 'Restoring a closed sidebar does not create an icon rail');
	assert.equal(restored.getPartSize('sessions').width + restored.getPartSize('editor').width + restored.getPartSize('auxiliarybar').width, 1_100);
	assert.equal(Math.abs(restored.getPartSize('auxiliarybar').width - 360) <= 1, true);
	assert.equal(restored.isPartVisible('auxiliarybar'), true, 'Editor and properties restore as independent Parts');
	assert.equal(restored.isPartVisible('editor'), true);
	assert.equal(Math.abs(restored.getPartSize('editor').width - 420) <= 1, true);

	restored.dispose();
	for (const part of restoredParts.values()) part.dispose();
	restoredStorage.dispose();
	dom.window.close();
});

test('Sessions ignores persisted editor widths captured below the usable minimum', async () => {
	const { StorageScope, StorageTarget } = await import('../../../platform/storage/common/storage.js');
	const dom = new JSDOM('', { url: 'https://editor-sizing.test' });
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'editor-sizing', backend: dom.window.localStorage, flushInterval: 0 });
	const parts = createParts(dom.window.document);
	try {
		storage.store('sessions.layout.editor.width', 120, StorageScope.PROFILE, StorageTarget.MACHINE);
		using layout = createLayout(dom.window.document.body, parts, { storageService: storage, initialDimension: new Dimension(1600, 900) });
		layout.layout(new Dimension(1600, 900));
		assert.equal(layout.state.editor.width, 600);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions layout completion exposes settled Parts through the window container service', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	using layout = createLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });
	const observed: unknown[] = [];
	using subscription = layout.onDidLayoutMainContainer(dimension => observed.push({ dimension, titlebar: layout.getPartSize('titlebar'), height: layout.getPartSize('sessions').height, offset: layout.mainContainerOffset.top }));
	layout.layout(new Dimension(1_400, 900));
	assert.deepEqual(observed, [{ dimension: new Dimension(1_400, 900), titlebar: new Dimension(1_400, WorkbenchWindowBarHeight), height: 900 - WorkbenchWindowBarHeight, offset: WorkbenchWindowBarHeight }]);
	assert.equal(layout.mainContainer, container);
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions Part availability preserves user visibility and cached widths during persistence', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	const parts = createParts(dom.window.document);
	using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_200, 800), storageService: storage });
	layout.layout(new Dimension(1_200, 800));
	layout.showPart('auxiliarybar');
	layout.resizePart('auxiliarybar', new Dimension(320, 800));
	layout.setPartAvailable('auxiliarybar', false);
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	assert.deepEqual(
		{ visible: layout.isPartVisible('auxiliarybar'), desired: layout.state.auxiliarybar },
		{ visible: false, desired: { width: 320, visible: true } },
	);
	layout.setPartAvailable('auxiliarybar', true);
	assert.deepEqual(
		{ visible: layout.isPartVisible('auxiliarybar'), width: layout.getPartSize('auxiliarybar').width },
		{ visible: true, width: 320 },
	);
	layout.setPartAvailable('auxiliarybar', false);
	layout.hidePart('auxiliarybar');
	layout.setPartAvailable('auxiliarybar', true);
	assert.deepEqual({ visible: layout.isPartVisible('auxiliarybar'), desired: layout.state.auxiliarybar.visible }, { visible: false, desired: false });
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Design replaces Sessions with a flexible page and preserves both side panel sizes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	using layout = createLayout(dom.window.document.body, parts);
	layout.layout(new Dimension(1400, 900));
	layout.resizePart('sidebar', new Dimension(260, 900));
	layout.resizePart('auxiliarybar', new Dimension(280, 900));
	const sidebarWidth = layout.getPartSize('sidebar').width;
	const auxiliaryWidth = layout.getPartSize('auxiliarybar').width;
	layout.updateParts(() => {
		layout.setPrimaryPart('editor');
		layout.showPart('editor');
		layout.setPartAvailable('sessions', false);
	});
	assert.equal(layout.isPartVisible('sessions'), false);
	assert.equal(layout.isPartVisible('editor'), true);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(layout.getPartSize('auxiliarybar').width, auxiliaryWidth);
	assert.equal(layout.state.auxiliarybar.width, auxiliaryWidth);
	layout.hidePart('auxiliarybar');
	assert.equal(layout.state.auxiliarybar.width, auxiliaryWidth);
	layout.showPart('auxiliarybar');
	const pageWidth = layout.getPartSize('editor').width;
	layout.layout(new Dimension(1600, 900));
	assert.equal(layout.getPartSize('editor').width, pageWidth + 200);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(layout.getPartSize('auxiliarybar').width, auxiliaryWidth);
	layout.hidePart('sidebar');
	assert.equal(parts.get('editor')!.domNode.classList.contains('ash-sessions-frame-start'), true);
	layout.showPart('sidebar');
	layout.updateParts(() => {
		layout.setPrimaryPart('sessions');
		layout.setPartAvailable('sessions', true);
		layout.hidePart('editor');
	});
	assert.equal(layout.isPartVisible('sessions'), true);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(layout.getPartSize('auxiliarybar').width, auxiliaryWidth);
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Design keeps the editor primary beside Agent and preserves conversation width through switching and restoration', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
	const parts = createParts(dom.window.document);
	const layout = createLayout(dom.window.document.body, parts, { storageService: storage, initialDimension: new Dimension(1600, 900) });
	try {
		layout.layout(new Dimension(1600, 900));
		layout.updateParts(() => { layout.setPrimaryPart('editor'); layout.showPart('editor'); layout.showPart('auxiliarybar'); });
		layout.resizePart('sessions', new Dimension(380, 900));
		const widths = () => ['sidebar', 'sessions', 'editor', 'auxiliarybar'].map(id => layout.getPartSize(id as SessionsPartId).width);
		const before = widths();
		assert.equal(parts.get('editor')!.domNode.contains(parts.get('auxiliarybar')!.domNode), false);
		layout.layout(new Dimension(1800, 900));
		assert.deepEqual(widths(), [before[0], before[1], before[2]! + 200, before[3]]);
		layout.setPartAvailable('sessions', false);
		layout.layout(new Dimension(1600, 900));
		layout.setPartAvailable('sessions', true);
		assert.deepEqual(widths(), before);
		layout.updateParts(() => { layout.setPrimaryPart('sessions'); layout.hidePart('editor'); layout.hidePart('auxiliarybar'); });
		layout.updateParts(() => { layout.setPrimaryPart('editor'); layout.showPart('editor'); layout.showPart('auxiliarybar'); });
		assert.deepEqual(widths(), before);
		await storage.flush(WillSaveStateReason.SHUTDOWN);
	} finally { layout.dispose(); for (const part of parts.values()) part.dispose(); }
	const restoredParts = createParts(dom.window.document);
	const restored = createLayout(dom.window.document.body, restoredParts, { storageService: storage, initialDimension: new Dimension(1600, 900) });
	try {
		restored.layout(new Dimension(1600, 900));
		restored.updateParts(() => { restored.setPrimaryPart('editor'); restored.showPart('editor'); restored.showPart('auxiliarybar'); restored.setPartAvailable('sessions', true); });
		assert.equal(restored.getPartSize('sessions').width, 380);
	} finally { restored.dispose(); for (const part of restoredParts.values()) part.dispose(); dom.window.close(); }
});

test('Sessions product page group survives legacy document group restoration', async () => {
	const { EditorPart } = await import('../../browser/parts/editorPart.js');
	const { createTestEditorServices } = await import('../../../workbench/test/common/testEditorServices.js');
	using services = createTestEditorServices();
	using editor = registerTestComponentServices(services).createInstance(EditorPart, browserEnvironment.window.document.body, {});
	const pages = editor.groups.find(group => group.id === editor.pageGroupId)!;
	await editor.applyWorkingSet({ id: 'legacy', activeGroupIndex: 1, groups: [1, 2].map(id => ({ id: 'editor-group-' + id, editors: [], activeEditorIndex: -1, size: 0.5 })) } as unknown as import('../../../workbench/services/editor/common/editorWorkingSet.js').EditorWorkingSet, { preserveGroups: [pages.id] });
	assert.equal(editor.groups.find(group => group.id === pages.id), pages);
	assert.equal(editor.isGroupVisible(pages.id), false);
	assert.equal(typeof editor.activeGroup.id, 'number');
	assert.notEqual(editor.activeGroup.id, pages.id);
	const documents = editor.saveWorkingSet('numeric-documents', [pages.id]);
	const firstId = documents.groups[0]!.id;
	const collision = JSON.parse(JSON.stringify(documents, (key, value) =>
		(key === 'id' || key === 'groupId') && value === firstId ? pages.id : value)) as typeof documents;
	await editor.applyWorkingSet(collision, { preserveGroups: [pages.id] });
	assert.equal(editor.groups.find(group => group.id === pages.id), pages);
	assert.equal(new Set(editor.groups.map(group => group.id)).size, editor.groups.length);
	assert.notEqual(editor.activeGroup.id, pages.id);

	assert.equal(editor.groups.length, 3);
});

test('Sessions recreates its document host when the last document group closes', async () => {
	const { EditorPart } = await import('../../browser/parts/editorPart.js');
	const { createTestEditorServices } = await import('../../../workbench/test/common/testEditorServices.js');
	using services = createTestEditorServices();
	using editor = registerTestComponentServices(services).createInstance(EditorPart, browserEnvironment.window.document.body, {});
	const pages = editor.groups.find(group => group.id === editor.pageGroupId)!;
	const documents = editor.activeGroup;
	await editor.removeGroup(documents);
	const remainingDocuments = editor.groups.filter(group => group.id !== pages.id);
	assert.equal(remainingDocuments.length, 1);
	assert.equal(editor.groups.find(group => group.id === pages.id), pages);
	assert.notEqual(remainingDocuments[0]!.id, documents.id);
	assert.equal(editor.activeGroup, remainingDocuments[0]);
	assert.equal(editor.isGroupVisible(remainingDocuments[0]!.id), true);
});

test('Sessions recreates a hidden document host without activating it over a product page', async () => {
	const { EditorPart } = await import('../../browser/parts/editorPart.js');
	const { createTestEditorServices } = await import('../../../workbench/test/common/testEditorServices.js');
	using services = createTestEditorServices();
	using editor = registerTestComponentServices(services).createInstance(EditorPart, browserEnvironment.window.document.body, {});
	const documents = editor.activeGroup;
	const pages = editor.groups.find(group => group.id === editor.pageGroupId)!;
	editor.setGroupVisible(pages.id, true);
	editor.setGroupVisible(documents.id, false);
	editor.activateGroup(pages.id);
	await editor.removeGroup(documents);
	const remainingDocuments = editor.groups.filter(group => group.id !== pages.id);
	assert.equal(remainingDocuments.length, 1);
	assert.equal(editor.activeGroup, pages);
	assert.equal(editor.isGroupVisible(remainingDocuments[0]!.id), false);
});

test('Sessions layout creation requires the registered storage service', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(DesktopWorkbenchLayout, dom.window.document.body, {}), /storageService|StorageService/);
	dom.window.close();
});

const layoutTestResources = new DisposableStore();
suiteTeardown(() => layoutTestResources.dispose());

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, WorkbenchPartInstance>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}, testServices?: import('../../../platform/instantiation/common/instantiationService.js').InstantiationService): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => { } }));
	const storage = options.storageService ?? ownedStorage!;
	const services = testServices ?? layoutTestResources.add(new InstantiationService());
	services.registerInstance(IStorageService, storage);
	const layout = services.createInstance(DesktopWorkbenchLayout, container, options);
	try {
		layout.createWorkbenchLayout(parts);
	} catch (error) {
		layout.dispose();
		throw error;
	}
	return layout;
}

test('Sessions compositions keep the content directly below the titlebar without a window banner', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_600, 1_000) });
		layout.layout(new Dimension(1_600, 1_000));
		assert.equal(layout.mainContainerOffset.top, WorkbenchWindowBarHeight);
		assert.equal(layout.mainContainerOffset.top, WorkbenchWindowBarHeight);
		assert.equal(layout.mainContainerOffset.top, WorkbenchWindowBarHeight);
		assert.equal(layout.domNode.querySelector('[data-part="banner"]'), null);
		assert.equal('banner' in layout.state, false);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

class TestLayoutAuxiliaryWindow extends Disposable implements IAuxiliaryWindow {
	readonly id = 1;
	readonly dom = new JSDOM('<!doctype html><body><main></main></body>');
	readonly window = this.dom.window as unknown as Window;
	readonly container = this.dom.window.document.querySelector('main')!;
	readonly onWillLayout = Event.None;
	readonly onDidLayout = Event.None;
	readonly onBeforeUnload = Event.None;
	private readonly closed = this._register(new Emitter<void>());
	readonly onDidClose = this.closed.event;
	readonly whenStylesHaveLoaded = Promise.resolve();
	private readonly closeDocument = this.dom.window.close.bind(this.dom.window);
	constructor() {
		super();
		this.dom.window.focus = () => { };
		this.dom.window.close = () => this.dispose();
		Object.defineProperties(this.container, { clientWidth: { value: 900 }, clientHeight: { value: 700 } });
	}
	layout(): void { }
	createState() { return { width: 900, height: 700, left: 0, top: 0, featureWidthOffset: 0, featureHeightOffset: 0 }; }
	protected override disposeCore(): void {
		this.closed.fire();
		super.disposeCore();
		this.closeDocument();
	}
}

class TestLayoutAuxiliaryWindows extends Disposable implements IAuxiliaryWindowService {
	readonly onDidOpenWindow = Event.None;
	readonly windows: TestLayoutAuxiliaryWindow[] = [];
	opening: Promise<void> | undefined;
	openCount = 0;
	async open(): Promise<IAuxiliaryWindow> {
		this.openCount++;
		await this.opening;
		const window = this._register(new TestLayoutAuxiliaryWindow());
		this.windows.push(window);
		return window;
	}
	getWindow(id: number) { return this.windows.find(window => window.id === id); }
}

function registerAuxiliaryViewServices(services: import('../../../platform/instantiation/common/instantiationService.js').InstantiationService, windows: IAuxiliaryWindowService, notifications: INotificationService): void {
	services.registerInstance(IAuxiliaryWindowService, windows);
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IAccessibleViewService, {
		show: () => false, getOpenAriaHint: () => undefined, async disableHint() { },
		showAccessibleViewHelp() { }, dispose() { }, [Symbol.dispose]() { },
	});
}

test('Saved Code card layouts reject duplicate, missing and malformed leaves', async () => {
	const { readCodeCardLayout } = await import('../../browser/codeCardLayout.js');
	const leaf = { type: 'leaf', data: 'panel', size: 300, visible: true, priority: 'normal' };
	assert.ok(readCodeCardLayout(JSON.stringify(leaf), ['panel']));
	assert.equal(readCodeCardLayout(JSON.stringify(leaf), ['panel', 'info']), undefined);
	assert.equal(
		readCodeCardLayout(
			JSON.stringify({
				type: 'branch',
				orientation: 'vertical',
				size: 300,
				priority: 'normal',
				children: [leaf, leaf],
			}),
			['panel'],
		),
		undefined,
	);
	assert.equal(readCodeCardLayout(JSON.stringify({ ...leaf, size: -1 }), ['panel']), undefined);
	assert.equal(readCodeCardLayout('{broken', ['panel']), undefined);
});

test('legacy Card migration keeps tool positions and visibility and includes each live group once', async () => {
	const { migrateCodeCardLayout } = await import('../../browser/codeCardLayout.js');
	const leaf = (data: string, size: number, visible = true) => ({ type: 'leaf' as const, data, size, visible, priority: LayoutPriority.Normal });
	const group = (groupId: number) => ({ ...leaf('', 1), data: { groupId } });
	const tree = {
		type: 'branch' as const, orientation: Orientation.HORIZONTAL, size: 1000, priority: LayoutPriority.Normal, children: [
			leaf('sessions', 400), leaf('files', 300), { type: 'branch' as const, orientation: Orientation.VERTICAL, size: 300, priority: LayoutPriority.Normal, children: [leaf('panel', 200, false), leaf('browser', 400)] },
		]
	};
	const mappings = new Map<string, import('../../../workbench/services/editor/common/editorWorkingSet.js').EditorWorkingSetLayout>([
		['files', { type: 'branch', orientation: Orientation.HORIZONTAL, size: 300, priority: LayoutPriority.Normal, children: [group(1), group(2)] }],
		// A mixed Files/Terminal group must retain one identity in the resulting Grid.
		['panel', { type: 'branch', orientation: Orientation.VERTICAL, size: 200, priority: LayoutPriority.Normal, children: [group(2), group(3)] }],
		['browser', group(4)],
	]);
	const layout = migrateCodeCardLayout(tree, mappings)!;
	assert.equal(layout.type, 'branch');
	if (layout.type !== 'branch') throw new Error('Expected a migrated split');
	assert.equal(layout.children.length, 2);
	assert.equal(layout.children[0]!.size, 300);
	const leaves: { id: number; visible: boolean; }[] = [];
	const visit = (node: import('../../../workbench/services/editor/common/editorWorkingSet.js').EditorWorkingSetLayout): void => { if (node.type === 'leaf') leaves.push({ id: node.data.groupId, visible: node.visible }); else node.children.forEach(visit); };
	visit(layout);
	assert.deepEqual(leaves, [{ id: 1, visible: true }, { id: 2, visible: true }, { id: 3, visible: false }, { id: 4, visible: true }]);
	assert.equal(migrateCodeCardLayout(tree, new Map()), undefined);
});

test('session working sets reuse live groups and preserve hidden entry geometry without crossing session scope', async () => {
	const { URI } = await import('../../../base/common/uri.js');
	const { observableValue } = await import('../../../base/common/observable.js');
	const { EditorPaneRegistry } = await import('../../../workbench/browser/editor.js');
	const { EditorPane } = await import('../../../workbench/browser/parts/editor/editorPane.js');
	const { IEditorPart } = await import('../../../workbench/browser/parts/editor/editorPart.js');
	const { IEditorService } = await import('../../../workbench/services/editor/common/editorService.js');
	const { ISessionsService } = await import('../../services/sessions/browser/sessionsService.js');
	const { ISessionsManagementService } = await import('../../services/sessions/common/sessionsManagement.js');
	const { ISessionChangesService } = await import('../../contrib/changes/common/sessionChangesService.js');
	const { IPaneCompositePartService } = await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const { ILifecycleService } = await import('../../../workbench/services/lifecycle/common/lifecycle.js');
	const { DesktopLayoutController } = await import('../../contrib/layout/browser/desktopLayoutController.js');
	type WorkingSet = import('../../../workbench/services/editor/common/editorWorkingSet.js').EditorWorkingSet;
	class Controller extends DesktopLayoutController {
		capture(key: string): WorkingSet { return this.getWorkingSet(key); }
		restore(saved: WorkingSet | 'empty', key: string): Promise<void> { return this.applyWorkingSet(saved, key); }
	}
	using services = registerTestComponentServices(createTestEditorServices(), browserEnvironment.window.document);
	using registry = new EditorPaneRegistry();
	let created = 0;
	registry.registerEditorPane({
		id: 'test.cached', name: 'Cached fixture', canOpen: () => 1, create: () => {
			created++;
			return new class extends EditorPane { readonly id = 'test.cached'; async setInput(): Promise<void> { } clearInput(): void { } layout(): void { } focus(): void { } }('test.cached', services.get(IThemeService), services.get(IStorageService));
		}
	});
	using hosts = createDesktopEditorTestServices(services, { registry });
	const { editor, area } = hosts;
	editor.layout(new Dimension(1200, 900));
	services.registerInstance(IEditorPart, editor);
	services.registerInstance(IEditorService, {} as import('../../../workbench/services/editor/common/editorService.js').IEditorService);
	services.registerInstance(ISessionsService, { activeSelection: undefined, getSelection: () => ({ activeSelection: undefined }) } as unknown as import('../../services/sessions/browser/sessionsService.js').ISessionsService);
	services.registerInstance(ISessionsManagementService, {} as import('../../services/sessions/common/sessionsManagement.js').ISessionsManagementService);
	services.registerInstance(ISessionChangesService, {} as import('../../contrib/changes/common/sessionChangesService.js').ISessionChangesService);
	services.registerInstance(IPaneCompositePartService, {} as import('../../../workbench/services/panecomposite/browser/panecomposite.js').IPaneCompositePartService);
	services.registerInstance(ILifecycleService, {} as import('../../../workbench/services/lifecycle/common/lifecycle.js').ILifecycleService);
	services.registerInstance(ILayoutService, {} as import('../../browser/workbench.js').IAgentWorkbenchLayoutService);
	using notifications = new TestNotificationService();
	services.registerInstance(INotificationService, notifications);
	using controller = services.createInstance(Controller, editor.pageGroupId, { isSessionContent: true, isDocumentContent: true, documentContent: observableValue('Code', true), isChangingContent: false, runOperation: (operation: () => Promise<void>) => operation() });
	const file = { resource: URI.file('/fixture/a.txt') };
	await editor.openEditor(file, { pinned: true });
	const first = editor.activeGroup, firstPane = first.activePane;
	const savedA = controller.capture('session:a');
	await controller.restore('empty', 'session:b');
	await editor.openEditor({ resource: URI.parse('ash-browser:/fixture/b') }, { pinned: true });
	const second = editor.activeGroup, secondPane = second.activePane;
	const savedB = controller.capture('session:b');
	await controller.restore(savedA, 'session:a');
	assert.equal(editor.activeGroup, first);
	assert.equal(first.activePane, firstPane);
	assert.equal(editor.isGroupVisible(second.id), false);
	controller.setDocumentGroupsVisible(false);
	await controller.restore(savedB, 'session:b');
	assert.equal(editor.groups.some(group => editor.isGroupVisible(group.id)), false);
	const hiddenSnapshot = controller.capture('session:b');
	assert.deepEqual((hiddenSnapshot as import('../../browser/parts/desktopEditorParts.js').DesktopEditorWorkingSet).toolParts, (savedB as import('../../browser/parts/desktopEditorParts.js').DesktopEditorWorkingSet).toolParts);
	controller.setDocumentGroupsVisible(true);
	assert.equal(editor.activeGroup, second);
	assert.equal(second.activePane, secondPane);
	assert.equal(editor.isGroupVisible(first.id), false);
	const before = area.saveLayout();
	controller.setDocumentGroupsVisible(false);
	controller.setDocumentGroupsVisible(true);
	assert.deepEqual(area.saveLayout(), before);
	await editor.openEditor(file, { pinned: true });
	assert.notEqual(editor.activeGroup, first, "opening a resource must not activate another session's cached group");
	assert.notEqual(editor.activeGroup, second, 'Files uses its own group beside the retained Browser');
	assert.equal(created, 3);
});

test('Agent Window has no Panel Part, Grid leaf or saved panel state even after legacy commands', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://retired-panel.test' });
	const parts = createParts(dom.window.document);
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'retired-panel', backend: dom.window.localStorage, flushInterval: 0 });
	storage.store('sessions.layout.panel.visible', true, StorageScope.PROFILE, (await import('../../../platform/storage/common/storage.js')).StorageTarget.MACHINE);
	try {
		using layout = createLayout(dom.window.document.body, parts, { storageService: storage });
		assert.equal(parts.has('panel' as SessionsPartId), false);
		assert.equal(layout.domNode.querySelector('[data-part="panel"]'), null);
		assert.equal('panel' in layout.state, false);
		assert.equal(storage.get('sessions.layout.panel.visible', StorageScope.PROFILE), undefined);
		layout.showPart('panel');
		layout.setPartAvailable('panel', true);
		layout.toggleMaximizedPanel();
		assert.equal(layout.isPartVisible('panel'), false);
		assert.equal(layout.isPartAvailable('panel'), false);
		assert.equal(layout.domNode.querySelector('[data-part="panel"]'), null);
		await storage.flush();
		assert.equal(storage.get('sessions.layout.panel.visible', StorageScope.PROFILE), undefined);
	} finally { for (const part of parts.values()) part.dispose(); dom.window.close(); }
});
