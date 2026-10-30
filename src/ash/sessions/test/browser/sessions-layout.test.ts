import { Orientation } from '../../../base/browser/ui/sash/sash.js';
import { Direction } from '../../../base/browser/ui/grid/grid.js';
import { createTestComponentServices, registerTestComponentServices } from '../../../workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
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
const { IStorageService, WillSaveStateReason } = await import('../../../platform/storage/common/storage.js');
const { InstantiationService } = await import('../../../platform/instantiation/common/instantiationService.js');
const { DesktopWorkbenchLayout } = await import('../../../sessions/browser/desktopWorkbench.js');
const { SessionsModernUIContribution } = await import('../../../sessions/contrib/modernUI/browser/modernUI.contribution.js');
const { SessionsConfiguration } = await import('../../../sessions/common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
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

function createParts(ownerDocument: Document): Map<SessionsPartId, WorkbenchPartInstance> {
	return new Map(sessionsPartIds.map(partId => [partId, new TestSessionsPart(partId, ownerDocument.body)]));
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
		drag(sidebar.minimumWidth - layout.getPartSize('sidebar').width - 20);
		assert.equal(layout.isPartVisible('sidebar'), true);
		assert.equal(layout.getPartSize('sidebar').width, sidebar.minimumWidth);
		drag(-100);
		assert.equal(layout.isPartVisible('sidebar'), false);
		assert.equal(layout.state.sidebar.visible, false);
		assert.equal(parts.get('titlebar')!.domNode.style.getPropertyValue('--ash-sessions-titlebar-sidebar-width'), '0px');
		layout.setPanelPosition(Position.RIGHT);
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

test('Sessions moves the retained Panel to all four edges and restores normal sizes after maximize', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	const input = dom.window.document.createElement('input');
	input.value = 'pending shell input';
	parts.get('panel')!.domNode.append(input);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1_600, 1_000) });
		assert.equal(layout.getSideBarPosition(), Position.LEFT);
		layout.layout(new Dimension(1_600, 1_000));
		layout.setPanelPosition(Position.BOTTOM);
		layout.showPart('panel');
		layout.resizePart('panel', new Dimension(layout.getPartSize('panel').width, 280));
		input.focus();
		const events: string[] = [];
		using subscription = layout.onDidChangePanelPosition(position => events.push(position));
		for (const position of [Position.LEFT, Position.TOP, Position.RIGHT, Position.BOTTOM]) {
			layout.setPanelPosition(position);
			assert.equal(layout.getPanelPosition(), position);
			assert.equal(layout.domNode.dataset.panelPosition, positionToString(position));
			assert.equal(dom.window.document.activeElement, input);
			assert.equal(input.value, 'pending shell input');
			assert.equal(layout.isPartVisible('panel'), true);
			assert.equal(layout.isPartVisible('sessions'), true);
			const panelFrame = parts.get('panel')!.domNode.parentElement!;
			const parentSplit = panelFrame.parentElement!.parentElement!;
			assert.equal(parentSplit.classList.contains('ash-split-view-vertical'), true);
			const leading = position === Position.TOP || position === Position.LEFT;
			const sessionsFrame = parts.get('sessions')!.domNode.parentElement!;
			assert.equal(!!(panelFrame.compareDocumentPosition(sessionsFrame) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING), leading);
			if (position === Position.TOP || position === Position.BOTTOM) assert.equal(layout.getPartSize('panel').height, 280);
			else layout.resizePart('panel', new Dimension(360, layout.getPartSize('panel').height));
		}
		assert.deepEqual(events, ['left', 'top', 'right', 'bottom']);
		layout.hidePart('panel');
		layout.setPanelPosition(Position.RIGHT);
		assert.equal(layout.isPartVisible('panel'), false);
		layout.showPart('panel');
		assert.equal(layout.getPartSize('panel').width, 360);
		layout.toggleMaximizedPanel();
		assert.equal(layout.isPanelMaximized(), true);
		assert.equal(layout.isPartVisible('sessions'), false);
		assert.equal(layout.getPartSize('panel').width > 360, true);
		layout.setPanelPosition(Position.TOP);
		assert.equal(layout.isPanelMaximized(), true);
		layout.toggleMaximizedPanel();
		assert.equal(layout.isPanelMaximized(), false);
		assert.equal(layout.isPartVisible('sessions'), true);
		assert.equal(layout.getPartSize('panel').height, 280);
		layout.setPanelPosition(Position.LEFT);
		assert.equal(layout.getPartSize('panel').width, 360);
		layout.toggleMaximizedPanel();
		layout.setPartAvailable('panel', false);
		assert.equal(layout.isPanelMaximized(), false);
		assert.equal(layout.isPartVisible('sessions'), true);
		layout.toggleMaximizedPanel();
		assert.equal(layout.isPanelMaximized(), false);
		assert.equal(layout.isPartVisible('sessions'), true);
		layout.setPartAvailable('panel', true);
		assert.equal(layout.getPartSize('panel').width, 360);
		layout.showPart('editor');
		layout.showPart('auxiliarybar');
		layout.setPanelPosition(Position.RIGHT);
		assert.equal(parts.get('editor')!.domNode.contains(parts.get('auxiliarybar')!.domNode), false);
		layout.setPrimaryPart('editor');
		layout.setPanelPosition(Position.LEFT);
		assert.equal(parts.get('editor')!.domNode.contains(parts.get('auxiliarybar')!.domNode), false);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Sessions restores Panel position and both axis sizes from the profile while hidden', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://sessions-panel.test' });
	const createStorage = () => new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'sessions', profileId: 'panel-positions', backend: dom.window.localStorage, flushInterval: 0 });
	const firstParts = createParts(dom.window.document);
	const storage = createStorage();
	const first = createLayout(dom.window.document.body, firstParts, { storageService: storage, initialDimension: new Dimension(1_600, 1_000) });
	first.layout(new Dimension(1_600, 1_000));
	first.setPanelPosition(Position.BOTTOM);
	first.showPart('panel');
	first.resizePart('panel', new Dimension(first.getPartSize('panel').width, 280));
	first.setPanelPosition(Position.RIGHT);
	first.resizePart('panel', new Dimension(380, first.getPartSize('panel').height));
	first.hidePart('panel');
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	first.dispose();
	storage.dispose();
	for (const part of firstParts.values()) part.dispose();
	const restoredParts = createParts(dom.window.document);
	try {
		using restoredStorage = createStorage();
		using restored = createLayout(dom.window.document.body, restoredParts, { storageService: restoredStorage, initialDimension: new Dimension(1_600, 1_000) });
		restored.layout(new Dimension(1_600, 1_000));
		assert.equal(restored.getPanelPosition(), Position.RIGHT);
		assert.equal(restored.isPartVisible('panel'), false);
		restored.showPart('panel');
		assert.equal(restored.getPartSize('panel').width, 380);
		restored.setPanelPosition(Position.TOP);
		assert.equal(restored.getPartSize('panel').height, 280);
	} finally {
		for (const part of restoredParts.values()) part.dispose();
		dom.window.close();
	}
});

test('Custom Views cover retained content without changing its desired visibility and sizes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	parts.set('customview', new TestSessionsPart('customview', dom.window.document.body));
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		layout.showPart('editor'); layout.showPart('auxiliarybar'); layout.showPart('panel');
		const previous = layout.state;
		layout.setCustomViewVisible(true);
		layout.toggleMaximizedPanel();
		assert.equal(layout.isPanelMaximized(), false);
		assert.equal(layout.isPartVisible('customview'), true);
		for (const id of ['sessions', 'editor', 'auxiliarybar', 'panel'] as const) assert.equal(layout.isPartVisible(id), false);
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
		for (const id of ['sidebar', 'sessions', 'editor', 'auxiliarybar', 'panel'] as const) assert.equal(layout.isPartVisible(id), true);
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

test('Code stacks Terminal and the complete Files card and restores their retained Parts across modes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		layout.layout(new Dimension(1600, 1000));
		assert.equal(layout.getPanelPosition(), Position.RIGHT);
		assert.equal(layout.isPartVisible('editor'), false);
		assert.equal(layout.isPartVisible('auxiliarybar'), true);
		layout.showPart('editor');
		layout.resizePart('editor', new Dimension(600, 1000));
		layout.showPart('panel');
		layout.resizePart('panel', new Dimension(300, 280));
		const editorWidth = layout.getPartSize('editor').width;
		const stackParent = () => parts.get('panel')!.domNode.parentElement!.parentElement!.parentElement!;
		assert.equal(stackParent(), layout.files.element.parentElement!.parentElement!);
		assert.equal(layout.files.card.contains(parts.get('auxiliarybar')!.domNode), true);
		assert.equal(layout.files.card.contains(parts.get('editor')!.domNode), true);
		assert.equal(stackParent().classList.contains('ash-split-view-vertical'), true);
		assert.equal(parts.get('editor')!.domNode.contains(parts.get('auxiliarybar')!.domNode), false);
		assert.equal(layout.getPartSize('panel').width, layout.getPartSize('auxiliarybar').width);
		assert.equal(layout.getPartSize('panel').height, 280);
		assert.equal(
			layout.getPartSize('panel').height + layout.getPartSize('auxiliarybar').height,
			1000 - WorkbenchWindowBarHeight,
		);
		layout.hidePart('auxiliarybar');
		assert.equal(layout.getPartSize('editor').width, editorWidth);
		layout.showPart('auxiliarybar');
		assert.equal(layout.getPartSize('panel').height, 280);
		const input = dom.window.document.createElement('input');
		parts.get('auxiliarybar')!.domNode.append(input);
		input.focus();
		layout.setPrimaryPart('editor');
		assert.equal(stackParent().classList.contains('ash-split-view-horizontal'), true);
		assert.equal(dom.window.document.activeElement, input);
		layout.setPrimaryPart('sessions');
		assert.equal(stackParent(), layout.files.element.parentElement!.parentElement!);
		assert.equal(layout.files.card.contains(parts.get('auxiliarybar')!.domNode), true);
		assert.equal(layout.files.card.contains(parts.get('editor')!.domNode), true);
		assert.equal(stackParent().classList.contains('ash-split-view-vertical'), true);
		assert.equal(dom.window.document.activeElement, input);
		assert.equal(layout.getPartSize('panel').height, 280);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Files moves and hides its tree and retained editor as one card', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		const document = dom.window.document.createElement('textarea');
		document.value = 'unsaved file content';
		parts.get('editor')!.domNode.append(document);
		layout.hidePart('auxiliarybar');
		layout.showPart('editor');
		assert.equal(layout.isCardVisible('files'), true);
		assert.equal(layout.files.card.contains(document), true);
		assert.equal(layout.files.card.contains(parts.get('auxiliarybar')!.domNode), true);
		layout.showPart('panel');
		layout.moveCard('files', 'terminal', Direction.Left);
		layout.closeCard('files');
		assert.equal(layout.isPartVisible('editor'), false);
		assert.equal(layout.isPartVisible('auxiliarybar'), false);
		layout.showPart('auxiliarybar');
		assert.equal(layout.isPartVisible('editor'), true);
		assert.equal(document.value, 'unsaved file content');
		assert.equal(layout.files.card.contains(document), true);
		layout.expandCard('files');
		assert.equal(layout.isPartVisible('editor'), true);
		assert.equal(layout.isPartVisible('auxiliarybar'), true);
		layout.expandCard('files');
		layout.detachCard('files', true);
		assert.equal(layout.files.card.hidden, false);
		assert.equal(parts.get('editor')!.domNode.hidden, false);
		layout.detachCard('files', false);
		assert.equal(layout.files.card.contains(document), true);
	} finally {
		for (const part of parts.values()) { part.dispose(); }
		dom.window.close();
	}
});

test('Files changes orientation in one Grid while retaining editor state and tree width', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	const input = dom.window.document.createElement('textarea');
	input.value = 'retained unsaved file';
	parts.get('editor')!.domNode.append(input);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(2000, 1000) });
		layout.showPart('editor');
		layout.resizePart('auxiliarybar', new Dimension(1000, 1000));
		const grid = layout.files.grid!;
		const element = grid.element;
		const treeSize = (): number => {
			const descriptor = grid.serialize();
			assert.equal(descriptor.type, 'branch');
			return descriptor.type === 'branch' ? descriptor.children[0]!.size : 0;
		};
		assert.equal(grid.orientation, Orientation.HORIZONTAL);
		const sash = grid.element.querySelector<HTMLElement>('.ash-sash-vertical')!;
		const previousWidth = treeSize();
		sash.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 200 }));
		for (const type of ['pointermove', 'pointerup']) {
			dom.window.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: 250 }));
		}
		assert.equal(treeSize(), previousWidth + 50);
		const treeWidth = treeSize();
		input.focus();
		input.setSelectionRange(2, 8);
		input.scrollTop = 70;

		for (const width of [900, 800, 700, 600, 500, 350]) {
			layout.resizePart('auxiliarybar', new Dimension(width, 1000));
		}
		assert.equal(layout.files.grid, grid);
		assert.equal(grid.orientation, Orientation.VERTICAL);
		assert.equal(dom.window.document.activeElement, input);
		assert.equal(layout.isPartVisible('editor'), true);
		for (const width of [500, 650, 800, 1000]) {
			layout.resizePart('auxiliarybar', new Dimension(width, 1000));
		}
		assert.equal(layout.files.grid, grid);
		assert.equal(grid.element, element);
		assert.equal(grid.orientation, Orientation.HORIZONTAL);
		assert.equal(treeSize(), treeWidth);
		assert.equal(dom.window.document.activeElement, input);
		assert.deepEqual([input.selectionStart, input.selectionEnd, input.scrollTop], [2, 8, 70]);
		assert.equal(input.value, 'retained unsaved file');

		layout.hidePart('editor');
		layout.resizePart('auxiliarybar', new Dimension(350, 1000));
		assert.equal(grid.orientation, Orientation.VERTICAL);
		assert.equal(layout.isPartVisible('editor'), false);
		layout.resizePart('auxiliarybar', new Dimension(1000, 1000));
		assert.equal(grid.orientation, Orientation.HORIZONTAL);
		assert.equal(layout.isPartVisible('editor'), false, 'orientation changes keep a closed editor hidden');
		assert.equal(layout.files.grid, grid);
		layout.showPart('editor');
		assert.equal(layout.files.card.contains(input), true);
		assert.equal(input.value, 'retained unsaved file');
		assert.equal(treeSize(), treeWidth, 'reopening the editor retains the user-established tree width');
		grid.element.querySelector<HTMLElement>('.ash-sash-vertical')!
			.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
		const resetWidth = treeSize();
		layout.resizePart('auxiliarybar', new Dimension(350, 1000));
		layout.resizePart('auxiliarybar', new Dimension(1000, 1000));
		assert.equal(treeSize(), resetWidth, 'a user reset becomes the preferred tree width');
	} finally {
		for (const part of parts.values()) {
			part.dispose();
		}
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
	assert.equal(layout.state.panel.height, 300);
	assert.ok(container.querySelector("[data-part='editor']"));
	assert.ok(container.querySelector("[data-part='sessions']"));

	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions layout style changes without changing the IDE preference or visible Parts', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const configuration = new WorkbenchConfigurationService();
	const layout = createLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });
	const appearance = new SessionsModernUIContribution(container, layout, configuration);
	const sessionsFrame = parts.get('sessions')!.domNode.parentElement as HTMLElement;
	const surface = () => ({
		style: container.dataset.layoutStyle,
		leftInset: sessionsFrame.style.paddingLeft,
		rightInset: sessionsFrame.style.paddingRight,
		bottomInset: sessionsFrame.style.paddingBottom,
	});
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.deepEqual(surface(), { style: 'flat', leftInset: '0px', rightInset: '0px', bottomInset: '0px' });
		assert.equal(container.classList.contains('modern-ui'), false);
		assert.equal(configuration.getValue(WorkbenchConfiguration.layoutStyle), 'modern');
		assert.equal(layout.isPartVisible('auxiliarybar'), true);
		await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
		assert.equal(container.dataset.layoutStyle, 'flat');
		await configuration.updateValue(SessionsConfiguration.layoutStyle, 'modern');
		layout.hidePart('auxiliarybar');
		assert.equal(sessionsFrame.style.paddingRight, '4px');
		assert.equal(sessionsFrame.style.paddingBottom, '4px');
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
	assert.deepEqual(sessions.layouts, [new Dimension(1_200 - 4, 800 - WorkbenchWindowBarHeight - 4)]);
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
		for (const sidebarAvailable of [true, false]) {
			layout.updateParts(() => {
				layout.setPartAvailable('sessions', false);
				layout.setPartAvailable('sidebar', sidebarAvailable);
				layout.setPrimaryPart('editor');
				layout.showPart('editor');
				if (!sidebarAvailable) { layout.hidePart('sidebar'); }
			});
			assert.equal(layout.state.sidebar.width, 300, 'Opening a product page retains the navigation width');
			layout.updateParts(() => {
				layout.setPrimaryPart('sessions');
				layout.setPartAvailable('sessions', true);
				layout.setPartAvailable('sidebar', true);
				layout.hidePart('editor');
				layout.showPart('sidebar');
			});
			assert.equal(layout.getPartSize('sidebar').width, 300, 'Returning to Chat retains the navigation width');
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
	const layout = createLayout(container, parts, {
		initialDimension: new Dimension(1_200, 800),
		activityBarLocation: ActivityBarPosition.TOP,
	});
	layout.hidePart('auxiliarybar');
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.equal(container.querySelector('[data-part="activitybar"]'), null);
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '6px');
		const expandedWidth = layout.getPartSize('sessions').width;
		layout.setActivityBarLocation(ActivityBarPosition.DEFAULT);
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '0px');
		assert.equal(layout.getPartSize('sessions').width >= expandedWidth, true);
		layout.hidePart('sidebar');
		assert.equal(layout.getPartSize('sessions').width, 1_200);
		assert.equal(layout.domNode.querySelector<HTMLElement>('.ash-sessions-content-card')!.style.left, '0px');
		layout.setActivityBarLocation(ActivityBarPosition.BOTTOM);
		layout.setActivityBarLocation(ActivityBarPosition.DEFAULT);
		layout.setPanelPosition(Position.RIGHT);
		assert.equal(container.querySelector('[data-part="activitybar"]'), null, 'Position changes and grid rebuilds do not create a separate navigation Part');
		assert.equal(layout.getPartSize('sessions').width, 1_200);
		layout.showPart('sidebar');
		layout.setActivityBarLocation(ActivityBarPosition.HIDDEN);
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '6px');
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
	parts.delete('panel');
	assert.throws(() => createLayout(container, parts), /missing Parts: panel/);

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
	const firstParts = createParts(dom.window.document);
	const first = createLayout(firstContainer, firstParts, { initialDimension: new Dimension(1_100, 700), storageService: firstStorage });
	first.layout(new Dimension(1_100, 700));
	first.resizePart('sidebar', new Dimension(320, first.getPartSize('sidebar').height));
	first.resizePart('auxiliarybar', new Dimension(360, first.getPartSize('auxiliarybar').height));
	first.hidePart('sidebar');
	first.hidePart('auxiliarybar');
	first.showPart('editor');
	first.resizePart('auxiliarybar', new Dimension(720, first.getPartSize('auxiliarybar').height));
	first.resizePart('editor', new Dimension(420, first.getPartSize('editor').height));
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.dispose();
	for (const part of firstParts.values()) part.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage();
	const restoredContainer = h(dom.window.document, 'main');
	const restoredParts = createParts(dom.window.document);
	const restored = createLayout(restoredContainer, restoredParts, { initialDimension: new Dimension(1_100, 700), storageService: restoredStorage });
	restored.layout(new Dimension(1_100, 700));

	assert.equal(Math.abs(restored.getPartSize('sidebar').width - 320) <= 1, true);
	assert.equal(restored.isPartVisible('sidebar'), false);
	assert.equal(restoredContainer.querySelector('[data-part="activitybar"]'), null, 'Restoring a closed sidebar does not create an icon rail');
	assert.equal(restored.getPartSize('sessions').width + restored.getPartSize('auxiliarybar').width, 1_100);
	assert.equal(Math.abs(restored.getPartSize('auxiliarybar').width - 720) <= 1, true);
	assert.equal(restored.isPartVisible('auxiliarybar'), true, 'Restoring a visible editor also restores its Files card');
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

function createLayout(container: HTMLElement, parts: ReadonlyMap<SessionsPartId, WorkbenchPartInstance>, options: import('../../browser/desktopWorkbench.js').SessionsWorkbenchLayoutOptions & { storageService?: import('../../../platform/storage/common/storage.js').IStorageService; } = {}): import('../../browser/desktopWorkbench.js').DesktopWorkbenchLayout {
	const ownedStorage = options.storageService ? undefined : layoutTestResources.add(new BrowserStorageService({ ownerWindow: container.ownerDocument.defaultView!, workspaceId: 'sessions', flushInterval: 0, onError: () => { } }));
	const storage = options.storageService ?? ownedStorage!;
	using services = new InstantiationService();
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
		layout.setPanelPosition(Position.RIGHT);
		assert.equal(layout.mainContainerOffset.top, WorkbenchWindowBarHeight);
		layout.toggleMaximizedPanel();
		assert.equal(layout.mainContainerOffset.top, WorkbenchWindowBarHeight);
		assert.equal(layout.domNode.querySelector('[data-part="banner"]'), null);
		assert.equal('banner' in layout.state, false);
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Code cards move in the Grid and restore exact dimensions after expanding every card', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	try {
		using layout = createLayout(dom.window.document.body, parts, { initialDimension: new Dimension(1600, 1000) });
		const info = dom.window.document.createElement('aside');
		layout.setInformation(info);
		layout.toggleInformation();
		layout.showPart('panel');
		layout.showPart('editor');
		layout.moveCard('info', 'files', Direction.Down);
		layout.moveCard('files', 'terminal', Direction.Up);
		layout.resizeCard('files', 0, 60);
		const terminal = layout.getPartSize('panel');
		const files = layout.getPartSize('auxiliarybar');
		for (const id of ['terminal', 'files', 'info'] as const) {
			layout.expandCard(id);
			assert.equal(layout.expandedCard, id);
			assert.equal(layout.isPartVisible('sessions'), false);
			layout.expandCard(id);
			assert.equal(layout.expandedCard, undefined);
			assert.equal(layout.isPartVisible('sessions'), true);
			assert.deepEqual(layout.getPartSize('panel'), terminal, `terminal geometry after restoring ${id}`);
			assert.deepEqual(layout.getPartSize('auxiliarybar'), files, `Files geometry after restoring ${id}`);
			assert.equal(layout.information.body.firstElementChild, info);
		}
		layout.detachCard('terminal', true);
		assert.equal(layout.isCardVisible('terminal'), true, 'toolbar stays selected for a detached terminal');
		assert.equal(parts.get('panel')!.domNode.hidden, false, 'the retained part remains usable in another document');
		layout.detachCard('terminal', false);
		assert.deepEqual(layout.getPartSize('panel'), terminal);
		assert.deepEqual(layout.getPartSize('auxiliarybar'), files);
		layout.detachCard('terminal', true);
		layout.moveCard('info', 'files', Direction.Up);
		layout.detachCard('terminal', false);
		assert.ok(
			layout.information.element.compareDocumentPosition(parts.get('auxiliarybar')!.domNode.parentElement!) &
			dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
		);
		layout.expandCard('info');
		layout.toggleInformation();
		assert.equal(layout.expandedCard, undefined);
		assert.equal(layout.isPartVisible('sessions'), true);
		layout.detachCard('terminal', true);
		layout.setPrimaryPart('editor');
		layout.showPart('editor');
		layout.detachCard('terminal', false);
		assert.equal(layout.isPartVisible('editor'), true);
		layout.setPrimaryPart('sessions');
	} finally {
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test('Code card topology survives product composition, hide/show and profile reload', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://cards.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'cards',
		profileId: 'cards',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const parts = createParts(dom.window.document);
	const layout = createLayout(dom.window.document.body, parts, {
		storageService: storage,
		initialDimension: new Dimension(1600, 1000),
	});
	layout.showPart('panel');
	layout.moveCard('files', 'terminal', Direction.Up);
	layout.resizeCard('files', 0, -50);
	const files = layout.getPartSize('auxiliarybar');
	layout.setPrimaryPart('editor');
	layout.setPrimaryPart('sessions');
	assert.deepEqual(layout.getPartSize('auxiliarybar'), files);
	layout.hidePart('auxiliarybar');
	layout.showPart('auxiliarybar');
	assert.deepEqual(layout.getPartSize('auxiliarybar'), files);
	layout.expandCard('terminal');
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	layout.dispose();
	for (const part of parts.values()) part.dispose();
	const restoredParts = createParts(dom.window.document);
	try {
		using restored = createLayout(dom.window.document.body, restoredParts, {
			storageService: storage,
			initialDimension: new Dimension(1600, 1000),
		});
		assert.equal(restored.expandedCard, undefined, 'expanded geometry never replaces the saved arrangement');
		assert.deepEqual(restored.getPartSize('auxiliarybar'), files);
		const fileFrame = restoredParts.get('auxiliarybar')!.domNode.parentElement!;
		const terminalFrame = restoredParts.get('panel')!.domNode.parentElement!;
		assert.ok(fileFrame.compareDocumentPosition(terminalFrame) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	} finally {
		for (const part of restoredParts.values()) part.dispose();
		dom.window.close();
	}
});

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

test('A legacy editor-only layout migrates into Files and keeps the grouped identity when closed', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const parts = createParts(dom.window.document);
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'legacy-files', flushInterval: 0 });
	try {
		using layout = createLayout(dom.window.document.body, parts, {
			storageService: storage,
			initialDimension: new Dimension(1600, 1000),
			initialState: {
				version: 1,
				sidebar: { width: 300, visible: true },
				auxiliarybar: { width: 340, visible: false },
				editor: { width: 600, visible: true },
				panel: { position: Position.RIGHT, width: 300, height: 280, visible: false },
			},
		});
		assert.equal(layout.isCardVisible('files'), true);
		assert.equal(layout.isPartVisible('editor'), true);
		assert.equal(layout.files.card.contains(parts.get('editor')!.domNode), true);
		layout.closeCard('files');
		assert.equal(layout.isPartVisible('editor'), false);
		assert.equal(layout.state.editor.visible, true, 'Closing Files retains the editor visibility to restore inside it');
		assert.equal(layout.state.auxiliarybar.visible, false);
	} finally {
		for (const part of parts.values()) { part.dispose(); }
		dom.window.close();
	}
});
