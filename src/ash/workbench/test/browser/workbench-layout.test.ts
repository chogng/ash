import { TestViewDescriptorService } from './workbenchTestServices.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { ActivityService } from '../../services/activity/browser/activityService.js';
import { IActivityService, NumberBadge } from '../../services/activity/common/activity.js';
import {
	BrowserAuxiliaryWindowService,
	IAuxiliaryWindowService,
} from '../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { LayoutActionsContext } from '../../browser/actions/layoutActions.js';
import {
	createTestComponentServices,
	registerTestComponentServices,
	createTestEditorServices,
} from '../common/testEditorServices.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IContextMenuProvider } from '../../../base/browser/contextmenu.js';
import type { IAction } from '../../../base/common/actions.js';
import { Emitter, Event as BaseEvent } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IViewPaneOptions, PartTitleProjection } from '../../../workbench/browser/parts/views/viewPane.js';
import { ContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { h } from '../../../base/browser/dom.js';
import type { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import { HoverService, IHoverService } from '../../../platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../platform/contextview/browser/contextViewService.js';

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
const { Lxicon } = await import('../../../base/common/lxicons.js');
const { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } =
	await import('../../../platform/storage/common/storage.js');
const { WorkbenchState } = await import('../../../platform/workspace/common/workspace.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { MenuId, IMenuService } = await import('../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../platform/actions/common/menuService.js');
const { WorkbenchLayout } = await import('../../../workbench/browser/layout.js');
const { createTestWorkbenchContextKeysHandler } =
	await import('../../../workbench/test/common/testWorkbenchContextKeys.js');
const { ILayoutService } = await import('../../../platform/layout/browser/layoutService.js');
const { IWorkbenchLayoutService, workbenchPartIds, Position } =
	await import('../../../workbench/services/layout/browser/layoutService.js');
const { BrowserStorageService } = await import('../../../workbench/services/storage/browser/storageService.js');
const paneStorageEnvironment = new JSDOM('<!doctype html><body></body>', { url: 'https://ash-pane.test' });
const paneStorage = new BrowserStorageService({
	ownerWindow: browserEnvironment.window as unknown as Window,
	workspaceId: 'window',
	backend: paneStorageEnvironment.window.localStorage,
	flushInterval: 0,
});
suiteTeardown(() => {
	paneStorage.dispose();
	paneStorageEnvironment.window.close();
});
const { InMemoryConfigurationService } =
	await import('../../../platform/configuration/common/inMemoryConfigurationService.js');
const { IConfigurationService } = await import('../../../platform/configuration/common/configuration.js');
const { TestQuickInputService } = await import('../../../platform/quickinput/test/browser/testQuickInputService.js');
const componentServices = createTestComponentServices(paneStorage);
componentServices.registerInstance(IWorkbenchLayoutService, {
	getSideBarPosition: () => Position.LEFT,
} as import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService);
suiteTeardown(() => componentServices.dispose());
const { Part } = await import('../../../workbench/browser/part.js');
const { SidebarPart } = await import('../../../workbench/browser/parts/sidebar/sidebarPart.js');
const { ActivitybarPart } = await import('../../../workbench/browser/parts/activitybar/activitybarPart.js');
const { PanelPart } = await import('../../../workbench/browser/parts/panel/panelPart.js');
const { IContextMenuService } = await import('../../../platform/contextview/browser/contextView.js');
const { IContextKeyService } = await import('../../../platform/contextkey/browser/contextKeyService.js');
const { IKeybindingService } = await import('../../../platform/keybinding/common/keybinding.js');
const { IViewDescriptorService } = await import('../../../workbench/common/views.js');
const { ILocalizationService: PanelLocalizationService } =
	await import('../../../workbench/services/localization/common/localizationService.js');
const { CompositeBar } = await import('../../../workbench/browser/parts/compositeBar.js');
const { AuxiliaryBarPart } = await import('../../../workbench/browser/parts/auxiliarybar/auxiliaryBarPart.js');
const { PaneComposite } = await import('../../browser/panecomposite.js');
const { ViewPane } = await import('../../../workbench/browser/parts/views/viewPane.js');
const { EditorPart } = await import('../../../workbench/browser/parts/editor/editorPart.js');
const { ViewDescriptorService } = await import('../../../workbench/services/views/browser/viewDescriptorService.js');
const { ViewContainerLocation, WorkbenchViewRegistry } = await import('../../../workbench/common/views.js');
const { ToggleSideBarCommandId } = await import('../../../workbench/browser/parts/titlebar/titlebarActions.js');
const { ToggleAuxiliaryBarAction } =
	await import('../../../workbench/browser/parts/auxiliarybar/auxiliaryBarActions.js');
const { TogglePanelAction } = await import('../../../workbench/browser/parts/panel/panelActions.js');
const { CommandService } = await import('../../../workbench/services/commands/common/commandService.js');
const { InstantiationService } = await import('../../../platform/instantiation/common/instantiationService.js');
const { SyncDescriptor } = await import('../../../platform/instantiation/common/descriptors.js');
const {} = await import('../../../platform/instantiation/common/instantiation.js');
type WorkbenchPartId = import('../../../workbench/services/layout/browser/layoutService.js').WorkbenchPartId;
type WorkbenchLayoutInstance = import('../../../workbench/browser/layout.js').WorkbenchLayout;
type WorkbenchLayoutOptions = import('../../../workbench/browser/layout.js').WorkbenchLayoutOptions & {
	readonly storageService?: import('../../../platform/storage/common/storage.js').IStorageService;
	readonly layoutStyle?: import('../../../workbench/common/configuration.js').WorkbenchLayoutStyle;
	readonly activityBarLocation?: import('../../../workbench/common/configuration.js').ActivityBarPosition;
	readonly panelDefaultLocation?: import('../../../workbench/common/configuration.js').PanelLocation;
	readonly sideBarLocation?: import('../../../workbench/common/configuration.js').SideBarLocation;
	readonly configurationValues?: Record<string, unknown>;
};
type WorkbenchPartInstance = import('../../../workbench/browser/part.js').Part;
type EditorPartInstance = import('../../../workbench/browser/parts/editor/editorPart.js').EditorPart;
class TestPart extends Part {
	constructor(
		readonly id: WorkbenchPartId,
		container: HTMLElement,
	) {
		const services = createTestComponentServices(undefined, undefined, container.ownerDocument);
		super(container, id, services.get(IThemeService), services.get(IStorageService));
		this._register(services);
	}

	override get minimumWidth(): number {
		if (this.id === 'activitybar') return 48;
		return this.id === 'sidebar' || this.id === 'auxiliarybar' || this.id === 'agentSidebar'
			? 170
			: this.id === 'editor'
				? 120
				: 0;
	}

	override get maximumWidth(): number {
		if (this.id === 'activitybar') return 48;
		return Number.POSITIVE_INFINITY;
	}

	override get minimumHeight(): number {
		if (this.id === 'banner') return 32;
		if (this.id === 'titlebar') return 35;
		if (this.id === 'statusbar') return 35;
		if (this.id === 'editor') return 84;
		if (this.id === 'panel') return 80;
		return 0;
	}

	override get maximumHeight(): number {
		if (this.id === 'banner') return 32;
		if (this.id === 'titlebar') return 35;
		if (this.id === 'statusbar') return 35;
		return Number.POSITIVE_INFINITY;
	}
}

function createLayoutHarness(
	ownerDocument: Document,
	options: Partial<WorkbenchLayoutOptions> = {},
	existingContainer?: HTMLElement,
	sidebarPart?: WorkbenchPartInstance,
): {
	readonly disposables: DisposableStore;
	readonly container: HTMLElement;
	readonly editor: EditorPartInstance;
	readonly layout: WorkbenchLayoutInstance;
	readonly services: InstanceType<typeof InstantiationService>;
	readonly configuration: InstanceType<typeof InMemoryConfigurationService>;
} {
	const disposables = new DisposableStore();
	const container = existingContainer ?? h(ownerDocument, 'main');
	ownerDocument.body.append(container);
	disposables.add(toDisposable(() => container.remove()));

	const {
		storageService,
		layoutStyle,
		activityBarLocation,
		sideBarLocation,
		panelDefaultLocation,
		configurationValues,
		...layoutOptions
	} = options;
	const configuration = disposables.add(new InMemoryConfigurationService());
	for (const [key, value] of Object.entries(configurationValues ?? {})) void configuration.updateValue(key, value);
	if (layoutStyle !== undefined) {
		void configuration.updateValue(WorkbenchConfiguration.layoutStyle, layoutStyle);
	}
	if (activityBarLocation !== undefined) {
		void configuration.updateValue(WorkbenchConfiguration.activityBarLocation, activityBarLocation);
	}
	if (sideBarLocation !== undefined) {
		void configuration.updateValue(WorkbenchConfiguration.sideBarLocation, sideBarLocation);
	}
	if (panelDefaultLocation !== undefined)
		void configuration.updateValue(WorkbenchConfiguration.panelDefaultLocation, panelDefaultLocation);
	let storage = storageService;
	if (!storage) {
		const storageDom = new JSDOM('', { url: 'https://ash.test' });
		disposables.add(toDisposable(() => storageDom.window.close()));
		storage = disposables.add(
			new BrowserStorageService({
				ownerWindow: ownerDocument.defaultView!,
				workspaceId: 'test',
				flushInterval: 0,
				backend: storageDom.window.localStorage,
			}),
		);
	}
	const services = disposables.add(createTestEditorServices(configuration, undefined, ownerDocument, storage));
	const layout = disposables.add(
		services.createInstance(WorkbenchLayout, container, {
			workbenchState: WorkbenchState.FOLDER,
			// Topology tests use a fixed viewport; the startup fallback test opts out.
			initialDimension: new Dimension(1_024, 768),
			...layoutOptions,
		}),
	);
	services.registerInstance(IWorkbenchLayoutService, layout);
	const parts = new Map<WorkbenchPartId, WorkbenchPartInstance>();
	let editor: EditorPartInstance | undefined;
	for (const partId of workbenchPartIds) {
		const part =
			partId === 'editor'
				? registerContainerServices(services).createInstance(EditorPart, container, {})
				: partId === 'sidebar' && sidebarPart
					? sidebarPart
					: new TestPart(partId, container);
		disposables.add(part);
		parts.set(partId, part);
		if (part instanceof EditorPart) editor = part;
	}
	if (!editor) throw new Error('Test layout requires an editor Part');

	layout.createParts(parts);
	return { disposables, container, editor, layout, configuration, services };
}

test('Workbench layout keeps the footer inside fractional container bounds on first layout and relayout', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	let height = 700.8;
	container.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1_000.2, height);
	Object.defineProperties(container, {
		clientWidth: { get: () => 1_000 },
		clientHeight: { get: () => Math.round(height) },
	});
	const harness = createLayoutHarness(dom.window.document, {}, container);
	try {
		const footer = container
			.querySelector('[data-part="statusbar"]')!
			.closest<HTMLElement>('.ash-split-view-pane')!;
		for (const nextHeight of [700.8, 700.2, 701.6]) {
			height = nextHeight;
			harness.layout.layout();
			assert.deepEqual(harness.layout.mainContainerDimension, new Dimension(1_000.2, height));
			assert.ok(Math.abs(parseFloat(footer.style.top) + parseFloat(footer.style.height) - height) < 0.001);
		}
	} finally {
		harness.disposables.dispose();
		dom.window.close();
	}
});

test('Workbench layout synchronizes Grid geometry during the window resize event and releases the listener', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	let bounds = { width: 1_024, height: 768 };
	container.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, bounds.width, bounds.height);
	const harness = createLayoutHarness(dom.window.document, {}, container);
	try {
		let layoutCalls = 0;
		const originalLayout = harness.layout.layout;
		harness.layout.layout = function (dimension) {
			layoutCalls++;
			originalLayout.call(this, dimension);
		};
		const layouts: { readonly width: number; readonly height: number }[] = [];
		harness.disposables.add(harness.layout.onDidLayoutMainContainer(dimension => layouts.push(dimension)));
		for (const size of [
			{ width: 1_200, height: 800 },
			{ width: 1_000.2, height: 699.6 },
		]) {
			bounds = size;
			dom.window.dispatchEvent(new dom.window.Event('resize'));
			assert.deepEqual(harness.layout.mainContainerDimension, new Dimension(size.width, size.height));
			assert.equal(harness.layout.getPartSize('titlebar').width, size.width);
		}
		assert.deepEqual(layouts, [new Dimension(1_200, 800), new Dimension(1_000.2, 699.6)]);
		harness.disposables.dispose();
		dom.window.dispatchEvent(new dom.window.Event('resize'));
		assert.equal(layouts.length, 2);
		assert.equal(layoutCalls, 2);
	} finally {
		harness.disposables.dispose();
		dom.window.close();
	}
});

test('Workbench layout hides and restores Parts with context keys', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const contextKeys = new ContextKeyService();
	const harness = createLayoutHarness(dom.window.document, { defaultLayout: { parts: { panel: true } } });
	harness.disposables.add(contextKeys);
	harness.disposables.add(createTestWorkbenchContextKeysHandler(contextKeys, { layoutService: harness.layout }));
	const overlay = h(dom.window.document, 'div');
	overlay.className = 'persistent-overlay';
	harness.container.append(overlay);

	harness.layout.layout(new Dimension(1_000, 700));
	assert.equal(harness.container.querySelectorAll('.ash-sash').length, 4);
	assert.equal(overlay.parentElement, harness.container);
	assert.ok(overlay.isConnected);
	assert.ok(harness.container.querySelector("[data-part='sidebar']"));
	assert.equal(contextKeys.getValue('sideBarVisible'), true);
	assert.equal(contextKeys.getValue('auxiliaryBarVisible'), true);
	assert.equal(contextKeys.getValue('agentSidebarVisible'), false);
	assert.equal(contextKeys.getValue('panelVisible'), true);
	assert.equal(contextKeys.getValue('panelMaximized'), false);
	const editorElement = harness.container.querySelector<HTMLElement>("[data-part='editor']");
	const panelElement = harness.container.querySelector<HTMLElement>("[data-part='panel']");
	const editorFrame = editorElement?.parentElement as HTMLElement | undefined;
	const panelFrame = panelElement?.parentElement as HTMLElement | undefined;
	const sidebarFrame = harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement as
		HTMLElement | undefined;
	const auxiliarybarFrame = harness.container.querySelector<HTMLElement>("[data-part='auxiliarybar']")
		?.parentElement as HTMLElement | undefined;
	assert.equal(editorFrame?.className, 'ash-workbench-part-frame');
	assert.equal(editorFrame?.style.paddingLeft, '2px');
	assert.equal(editorFrame?.style.paddingRight, '2px');
	assert.equal(editorFrame?.style.paddingBottom, '2px');
	assert.equal(panelFrame?.style.paddingTop, '2px');
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');
	assert.equal(sidebarFrame?.style.paddingRight, '2px');
	assert.equal(auxiliarybarFrame?.style.paddingLeft, '2px');
	assert.equal(auxiliarybarFrame?.style.paddingRight, '4px');
	for (const sash of harness.container.querySelectorAll<HTMLElement>('.ash-sash')) {
		assert.equal(sash.classList.contains('ash-sash-inset'), true);
		assert.equal(sash.style.getPropertyValue('--ash-sash-inset-gap'), '4px');
	}
	harness.layout.hideParts(['sidebar', 'auxiliarybar', 'panel']);
	assert.ok(overlay.isConnected);
	assert.equal(harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.hidden, true);
	assert.equal(harness.container.querySelector<HTMLElement>("[data-part='auxiliarybar']")?.hidden, true);
	assert.ok(harness.container.querySelector("[data-part='editor']"));
	assert.equal(harness.container.querySelector("[data-part='session']"), null);
	assert.equal(contextKeys.getValue('sideBarVisible'), false);
	assert.equal(contextKeys.getValue('auxiliaryBarVisible'), false);
	assert.equal(contextKeys.getValue('panelVisible'), false);
	assert.equal(contextKeys.getValue('editorAreaVisible'), true);
	assert.equal(editorFrame?.style.paddingLeft, '4px');
	assert.equal(editorFrame?.style.paddingRight, '4px');
	assert.equal(editorFrame?.style.paddingBottom, '0px');
	assert.equal(panelFrame?.style.paddingLeft, '4px');
	assert.equal(harness.layout.isPartVisible('activitybar'), true);
	assert.equal(harness.layout.getPartSize('activitybar').width, 52);
	assert.equal(panelFrame?.style.paddingRight, '4px');
	harness.layout.showPart('agentSidebar');
	assert.equal(contextKeys.getValue('agentSidebarVisible'), true);
	harness.layout.hidePart('agentSidebar');
	assert.equal(contextKeys.getValue('agentSidebarVisible'), false);
	harness.layout.showPart('sidebar');
	assert.equal(harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.hidden, false);
	assert.equal(contextKeys.getValue('sideBarVisible'), true);
	assert.equal(editorFrame?.style.paddingLeft, '2px');
	assert.equal(editorFrame?.style.paddingRight, '4px');
	harness.layout.showPart('panel');
	harness.layout.hidePart('editor');
	assert.equal(contextKeys.getValue('panelMaximized'), true);
	harness.layout.showPart('editor');
	assert.equal(contextKeys.getValue('panelMaximized'), false);

	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench layout switches between modern and flat geometry without replacing Parts', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		layoutStyle: 'modern',
	});
	harness.layout.layout(new Dimension(1_200, 800));
	const state = harness.layout.state;
	const editor = harness.container.querySelector<HTMLElement>("[data-part='editor']");
	const editorFrame = editor?.parentElement as HTMLElement | undefined;
	const sidebarFrame = harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement as
		HTMLElement | undefined;
	assert.equal(editorFrame?.style.paddingLeft, '2px');
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');
	assert.equal(harness.container.querySelectorAll('.ash-sash-inset').length, 4);

	harness.layout.setLayoutStyle('flat');

	assert.equal(editorFrame?.style.paddingLeft, '0px');
	assert.equal(editorFrame?.style.paddingRight, '0px');
	assert.equal(editorFrame?.style.paddingBottom, '0px');
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');
	assert.equal(sidebarFrame?.style.paddingRight, '0px');
	assert.equal(harness.container.querySelectorAll('.ash-sash-inset').length, 0);
	assert.deepEqual(harness.layout.state, state);
	assert.equal(harness.container.querySelector("[data-part='editor']"), editor);

	harness.layout.setLayoutStyle('modern');

	assert.equal(editorFrame?.style.paddingLeft, '2px');
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');
	assert.equal(harness.container.querySelectorAll('.ash-sash-inset').length, 4);
	assert.deepEqual(harness.layout.state, state);

	harness.disposables.dispose();
	dom.window.close();
});

test('Activity Bar badge setting applies on startup and preserves per-icon choices after rehosting', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const harness = createLayoutHarness(dom.window.document);
		using disposables = harness.disposables;
		const { ILocalizationService } =
			await import('../../../workbench/services/localization/common/localizationService.js');
		harness.services.registerInstance(ILocalizationService, {
			whenReady: Promise.resolve(),
			translate: (_bundle, _key, fallback) => fallback,
		});
		await harness.configuration.updateValue(WorkbenchConfiguration.activityBarBadges, false);
		const registry = new WorkbenchViewRegistry();
		for (const id of ['first', 'second']) {
			disposables.add(registry.registerViewContainer({ id, title: id, location: ViewContainerLocation.Sidebar }));
		}
		const contextKeys = disposables.add(new ContextKeyService());
		const views = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
		const activity = disposables.add(new ActivityService(views));
		const bar = disposables.add(
			new CompositeBar(
				harness.container,
				{
					overflowActionSize: 22,
					openComposite: async () => null,
					activityHoverOptions: { position: () => HoverPosition.RIGHT },
					viewDescriptorService: views,
					location: ViewContainerLocation.Sidebar,
					ariaLabel: 'Views',
					orientation: 'vertical',
				},
				activity,
			),
		);
		const firstBadge = disposables.add(new MutableDisposable());
		firstBadge.value = activity.showViewContainerActivity('first', {
			badge: new NumberBadge(1, () => '1 unsaved file'),
		});
		disposables.add(activity.showViewContainerActivity('second', { badge: new NumberBadge(2, () => '2') }));
		bar.toggleBadgeEnablement('second');
		const globalBar = { domNode: dom.window.document.createElement('div'), getContextMenuActions: () => [] };
		using activityServices = harness.services.createChild();
		activityServices.registerInstance(IContextKeyService, contextKeys);
		activityServices.registerInstance(IKeybindingService, {
			lookupKeybinding: () => undefined,
		} as unknown as import('../../../platform/keybinding/common/keybinding.js').IKeybindingService);
		activityServices.registerInstance(
			IMenuService,
			new MenuService(disposables.add(new CommandService(activityServices)), contextKeys),
		);
		disposables.add(activityServices.createInstance(ActivitybarPart, harness.container, bar, globalBar));
		const first = (): HTMLElement => bar.domNode.querySelector('[data-action-id="first"]')!;
		assert.equal(bar.domNode.querySelector('.ash-count-badge'), null);
		firstBadge.value = activity.showViewContainerActivity('first', {
			badge: new NumberBadge(3, () => '3 unsaved files'),
		});
		harness.container.append(bar.domNode);
		bar.setOrientation('horizontal');
		first().focus();
		await harness.configuration.updateValue(WorkbenchConfiguration.activityBarBadges, true);
		assert.deepEqual(
			[...bar.domNode.querySelectorAll('.ash-count-badge')].map(badge => badge.textContent),
			['3'],
		);
		assert.equal(first().getAttribute('aria-label'), 'first, 3 unsaved files');
		assert.equal(dom.window.document.activeElement, first());
		await harness.configuration.updateValue(WorkbenchConfiguration.activityBarBadges, false);
		bar.toggleBadgeEnablement('second');
		assert.equal(bar.domNode.querySelector('.ash-count-badge'), null);
		await harness.configuration.updateValue(WorkbenchConfiguration.activityBarBadges, undefined);
		assert.deepEqual(
			[...bar.domNode.querySelectorAll('.ash-count-badge')].map(badge => badge.textContent),
			['3', '2'],
		);
	} finally {
		dom.window.close();
	}
});

test('Activity Bar top and bottom positions keep the full sidebar height', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		layoutStyle: 'modern',
	});
	harness.layout.layout(new Dimension(1_200, 800));
	const sidebarHeight = harness.layout.getPartSize('sidebar').height;
	const sidebarFrame = harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement;
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');

	for (const location of [ActivityBarPosition.TOP, ActivityBarPosition.BOTTOM]) {
		harness.layout.setActivityBarLocation(location);
		assert.equal(harness.layout.isPartVisible('activitybar'), false);
		assert.equal(harness.layout.domNode.classList.contains('activitybar-absent'), true);
		assert.equal(harness.layout.getPartSize('sidebar').height, sidebarHeight);
		assert.equal(sidebarFrame?.style.paddingLeft, '4px');
	}

	harness.layout.setSideBarLocation('right');
	assert.equal(sidebarFrame?.style.paddingRight, '4px');
	harness.layout.setActivityBarLocation(ActivityBarPosition.HIDDEN);
	assert.equal(sidebarFrame?.style.paddingRight, '4px');
	harness.layout.setActivityBarLocation(ActivityBarPosition.DEFAULT);
	assert.equal(harness.layout.isPartVisible('activitybar'), true);
	assert.equal(harness.layout.domNode.classList.contains('activitybar-absent'), false);
	assert.equal(sidebarFrame?.style.paddingRight, '0px');
	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench layout assigns the window edge inset on startup from the Activity Bar position', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		layoutStyle: 'modern',
		activityBarLocation: ActivityBarPosition.TOP,
	});
	harness.layout.layout(new Dimension(1_200, 800));
	const sidebarFrame = harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement;
	assert.equal(harness.layout.domNode.classList.contains('activitybar-absent'), true);
	assert.equal(sidebarFrame?.style.paddingLeft, '4px');
	harness.layout.setLayoutStyle('flat');
	assert.equal(sidebarFrame?.style.paddingLeft, '0px');
	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench pane sashes snap closed while Auxiliary Bar stops at its minimum', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const contextKeys = new ContextKeyService();
	const harness = createLayoutHarness(dom.window.document, { initialDimension: new Dimension(1_200, 800) });
	harness.disposables.add(contextKeys);
	harness.disposables.add(createTestWorkbenchContextKeysHandler(contextKeys, { layoutService: harness.layout }));
	harness.layout.layout(new Dimension(1_200, 800));

	dragWorkbenchSash(dom.window, harness.container, 'sidebar', 0, -harness.layout.getPartSize('sidebar').width);
	assert.equal(harness.layout.isPartVisible('sidebar'), false);
	assert.equal(contextKeys.getValue('sideBarVisible'), false);
	dragWorkbenchSash(dom.window, harness.container, 'sidebar', 0, 110);
	assert.equal(harness.layout.isPartVisible('sidebar'), true);

	dragWorkbenchSash(dom.window, harness.container, 'auxiliarybar', 1, 320);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), true);
	assert.equal(contextKeys.getValue('auxiliaryBarVisible'), true);
	const auxiliaryFrame = harness.container.querySelector<HTMLElement>("[data-part='auxiliarybar']")!.parentElement!;
	const frameInsets =
		(Number.parseFloat(auxiliaryFrame.style.paddingLeft) || 0) +
		(Number.parseFloat(auxiliaryFrame.style.paddingRight) || 0);
	assert.equal(harness.layout.getPartSize('auxiliarybar').width, 170 + frameInsets);
	dragWorkbenchSash(dom.window, harness.container, 'auxiliarybar', 1, -110);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), true);

	dragWorkbenchSash(dom.window, harness.container, 'panel', 0, harness.layout.getPartSize('panel').height);
	assert.equal(harness.layout.isPartVisible('panel'), false);
	assert.equal(contextKeys.getValue('panelVisible'), false);
	dragWorkbenchSash(dom.window, harness.container, 'panel', 0, -50);
	assert.equal(harness.layout.isPartVisible('panel'), true);

	dragWorkbenchSash(dom.window, harness.container, 'agentSidebar', 2, -110);
	assert.equal(harness.layout.isPartVisible('agentSidebar'), true);
	assert.equal(contextKeys.getValue('agentSidebarVisible'), true);
	dragWorkbenchSash(dom.window, harness.container, 'agentSidebar', 2, 120);
	assert.equal(harness.layout.isPartVisible('agentSidebar'), false);
	dragWorkbenchSash(dom.window, harness.container, 'agentSidebar', 2, -110);
	assert.equal(harness.layout.isPartVisible('agentSidebar'), true);

	harness.disposables.dispose();
	dom.window.close();
});

test('platform and Workbench dependencies resolve one owner and publish completed Part geometry', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document);
	class LayoutConsumer {
		constructor(
			@ILayoutService
			readonly platform: import('../../../platform/layout/browser/layoutService.js').ILayoutService,
			@IWorkbenchLayoutService
			readonly workbench: import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService,
		) {}
	}
	const consumer = harness.services.createInstance(LayoutConsumer);
	assert.equal(consumer.platform, harness.layout);
	assert.equal(consumer.workbench, harness.layout);
	const layoutService = consumer.workbench;
	const events: string[] = [];
	for (const [name, event] of [
		['container', layoutService.onDidLayoutContainer],
		['main', layoutService.onDidLayoutMainContainer],
		['active', layoutService.onDidLayoutActiveContainer],
	] as const) {
		harness.disposables.add(
			event(() => {
				assert.equal(harness.layout.getPartSize('titlebar').width, 1_200);
				assert.deepEqual(consumer.platform.activeContainerOffset, { top: 35, quickInputTop: 0 });
				events.push(name);
			}),
		);
	}

	layoutService.layout(new Dimension(1_200, 800));

	assert.deepEqual(events, ['container', 'main', 'active']);
	assert.deepEqual(layoutService.mainContainerDimension, new Dimension(1_200, 800));
	assert.equal(harness.layout.getPartSize('titlebar').height, 35);
	assert.equal(harness.layout.getPartSize('statusbar').height, 35);
	assert.ok(harness.editor.domNode.isConnected);

	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench layout requires its services and hosts overlays before Parts creation', () => {
	using services = new InstantiationService();
	const dom = new JSDOM('', { url: 'https://ash.test' });
	const container = h(dom.window.document, 'main');
	const options = { workbenchState: WorkbenchState.FOLDER };
	assert.throws(() => services.createInstance(WorkbenchLayout, container, options), /storageService/);
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'test',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	services.registerInstance(IStorageService, storage);
	assert.throws(() => services.createInstance(WorkbenchLayout, container, options), /configurationService/);
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	assert.throws(() => services.createInstance(WorkbenchLayout, container, options), /auxiliaryWindowService/);
	registerTestComponentServices(services, dom.window.document);
	using layout = services.createInstance(WorkbenchLayout, container, options);
	services.registerInstance(IWorkbenchLayoutService, layout);
	using contextKeys = new ContextKeyService();
	using quickInput = new TestQuickInputService({
		instantiationService: services,
		container,
		contextKeyService: contextKeys,
		layoutService: services.get(ILayoutService),
	});
	using picker = quickInput.createQuickPick();
	picker.show();
	assert.equal(layout.activeContainer, container);
	assert.deepEqual(layout.activeContainerOffset, { top: 0, quickInputTop: 0 });
	assert.equal(container.querySelector<HTMLElement>('.ash-quick-input-host')?.hidden, false);
	picker.hide();
	dom.window.close();
});

test('Panel position commands preserve visibility, both axis sizes, focus and scoped storage', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash-panel-position.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'position',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const harness = createLayoutHarness(dom.window.document, {
		storageService: storage,
		defaultLayout: { parts: { panel: true } },
	});
	using resources = harness.disposables;
	using context = new ContextKeyService();
	using positionContext = createTestWorkbenchContextKeysHandler(context, { layoutService: harness.layout });
	using commands = new CommandService(harness.services);
	const menus = new MenuService(commands, context);
	const positionMenu = () => menus.getMenuActions(MenuId.for('PanelPositionMenu')).flatMap(([, actions]) => actions);
	const events: string[] = [];
	resources.add(harness.layout.onDidChangePanelPosition(position => events.push(position)));
	harness.layout.layout(new Dimension(1_800, 900));
	harness.layout.resizePart('panel', new Dimension(1_000, 180));
	const input = dom.window.document.createElement('textarea');
	harness.container.querySelector('[data-part="panel"]')!.append(input);
	input.focus();
	for (const [suffix, position] of [
		['Left', Position.LEFT],
		['Right', Position.RIGHT],
		['Top', Position.TOP],
		['Bottom', Position.BOTTOM],
	] as const) {
		await commands.executeCommand(`workbench.action.positionPanel${suffix}`);
		assert.equal(harness.layout.getPanelPosition(), position);
		assert.equal(positionMenu().find(action => action.checked)?.id, `workbench.action.positionPanel${suffix}`);
		assert.equal(dom.window.document.activeElement, input);
		assert.equal(harness.layout.isPartVisible('panel'), true);
		if (position === Position.LEFT || position === Position.RIGHT) {
			assert.equal(harness.layout.getPartSize('panel').width, 256);
			harness.layout.resizePart('panel', new Dimension(256, 800));
		} else {
			assert.equal(harness.layout.getPartSize('panel').height, 180);
		}
	}
	assert.deepEqual(events, ['left', 'right', 'top', 'bottom']);
	await positionMenu()
		.find(action => action.id.endsWith('Left'))!
		.run();
	harness.layout.resizePart('panel', new Dimension(350, 800));
	harness.layout.hidePart('panel');
	await commands.executeCommand('workbench.action.positionPanelRight');
	assert.equal(harness.layout.isPartVisible('panel'), true);
	harness.layout.showPart('panel');
	assert.equal(harness.layout.getPartSize('panel').width, 350);
	harness.layout.toggleMaximizedPanel();
	await commands.executeCommand('workbench.action.positionPanelTop');
	assert.equal(harness.layout.isPanelMaximized(), true);
	harness.layout.toggleMaximizedPanel();
	assert.equal(harness.layout.getPartSize('panel').height, 180);
	await commands.executeCommand('workbench.action.positionPanelRight');
	assert.equal(harness.layout.getPartSize('panel').width, 350);
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	const restored = createLayoutHarness(dom.window.document, {
		storageService: storage,
		initialDimension: new Dimension(1_800, 900),
	});
	restored.layout.layout(new Dimension(1_800, 900));
	assert.equal(restored.layout.getPanelPosition(), Position.RIGHT);
	assert.equal(restored.layout.getPartSize('panel').width, 350);
	assert.equal(restored.layout.state.panel.height, 180);
	restored.disposables.dispose();
	resources.dispose();
	dom.window.close();
});

test('maximized Panel survives configuration changes and restores its saved height', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, { defaultLayout: { parts: { panel: true } } });
	using disposables = harness.disposables;
	const contextKeys = disposables.add(new ContextKeyService());
	disposables.add(createTestWorkbenchContextKeysHandler(contextKeys, { layoutService: harness.layout }));
	using services = new InstantiationService();
	services.registerInstance(IWorkbenchLayoutService, harness.layout);
	const commands = disposables.add(new CommandService(services));
	harness.layout.layout(new Dimension(1_200, 800));
	harness.layout.resizePart('panel', new Dimension(harness.layout.getPartSize('panel').width, 180));

	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	await harness.configuration.updateValue(WorkbenchConfiguration.sideBarLocation, 'right');
	await harness.configuration.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.HIDDEN);
	assert.deepEqual(
		{
			maximized: harness.layout.isPanelMaximized(),
			editorVisible: harness.layout.isPartVisible('editor'),
			contextMaximized: contextKeys.getValue('panelMaximized'),
			savedPanel: harness.layout.state.panel,
		},
		{
			maximized: true,
			editorVisible: false,
			contextMaximized: true,
			savedPanel: { position: Position.BOTTOM, width: 256, height: 180, visible: true },
		},
	);

	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	assert.equal(harness.layout.getPartSize('panel').height, 180);
	assert.equal(contextKeys.getValue('panelMaximized'), false);
	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	// ViewsService and other callers close Parts directly, without going through the titlebar command.
	harness.layout.hidePart('panel');
	assert.equal(harness.layout.isPartVisible('editor'), true);
	harness.layout.showPart('panel');
	assert.equal(harness.layout.isPanelMaximized(), true);
	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	assert.equal(harness.layout.getPartSize('panel').height, 180);
	harness.layout.hidePart('editor');
	harness.layout.showPart('editor');
	harness.layout.resizePart('panel', new Dimension(harness.layout.getPartSize('panel').width, 210));
	assert.equal(harness.layout.state.panel.height, 210);
	harness.layout.toggleMaximizedPanel();
	harness.layout.restoreWorkspaceState();
	assert.equal(harness.layout.isPartVisible('editor'), true);
	disposables.dispose();
	dom.window.close();
});

test('Auxiliary Bar commands restore dimensions, hidden Parts and Panel maximization across layout changes', async () => {
	const { IPaneCompositePartService } =
		await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const harness = createLayoutHarness(dom.window.document, {
			defaultLayout: { parts: { panel: true, agentSidebar: true } },
		});
		using resources = harness.disposables;
		const context = resources.add(new ContextKeyService());
		resources.add(createTestWorkbenchContextKeysHandler(context, { layoutService: harness.layout }));
		harness.services.registerInstance(IPaneCompositePartService, {
			getProgressIndicator: () => undefined,
			onDidPaneCompositeOpen: BaseEvent.None,
			onDidPaneCompositeClose: BaseEvent.None,
			getActivePaneComposite: () => undefined,
			getLastActivePaneCompositeId: () => undefined,
			openPaneComposite: async () => undefined,
			hideActivePaneComposite() {},
			getPartId: () => 'auxiliarybar',
		});
		const commands = resources.add(new CommandService(harness.services));
		harness.layout.layout(new Dimension(1600, 900));
		harness.layout.resizePart('auxiliarybar', new Dimension(320, 800));
		harness.layout.resizePart('panel', new Dimension(800, 180));
		const ordinary = harness.layout.state;
		for (const panelMaximized of [false, true]) {
			if (panelMaximized) harness.layout.toggleMaximizedPanel();
			await commands.executeCommand('workbench.action.toggleMaximizedAuxiliaryBar');
			assert.equal(harness.layout.setAuxiliaryBarMaximized(true), false);
			assert.equal(context.getValue('auxiliaryBarMaximized'), true);
			assert.equal(context.getValue('panelMaximized'), false);
			for (const partId of ['editor', 'panel', 'sidebar', 'agentSidebar'] as const) {
				assert.equal(harness.layout.isPartVisible(partId), false, partId);
			}
			assert.deepEqual(harness.layout.state, ordinary);
			await harness.configuration.updateValue(
				WorkbenchConfiguration.sideBarLocation,
				panelMaximized ? 'left' : 'right',
			);
			assert.equal(harness.layout.isAuxiliaryBarMaximized(), true);
			assert.equal(harness.layout.isPartVisible('sidebar'), false);
			await commands.executeCommand('workbench.action.toggleMaximizedAuxiliaryBar');
			assert.equal(context.getValue('auxiliaryBarMaximized'), false);
			assert.equal(harness.layout.isPanelMaximized(), panelMaximized);
			if (panelMaximized) harness.layout.toggleMaximizedPanel();
			assert.deepEqual(harness.layout.state, ordinary);
		}
		harness.layout.hidePart('sidebar');
		harness.layout.hidePart('panel');
		const hiddenWidth = harness.layout.getPartSize('auxiliarybar').width;
		await commands.executeCommand('workbench.action.toggleMaximizedAuxiliaryBar');
		await commands.executeCommand('workbench.action.closeAuxiliaryBar');
		assert.equal(harness.layout.isAuxiliaryBarMaximized(), false);
		assert.equal(harness.layout.isPartVisible('editor'), true);
		assert.equal(harness.layout.isPartVisible('sidebar'), false);
		assert.equal(harness.layout.isPartVisible('panel'), false);
		await commands.executeCommand(ToggleAuxiliaryBarAction.ID);
		assert.equal(harness.layout.getPartSize('auxiliarybar').width, hiddenWidth);
		harness.layout.toggleMaximizedAuxiliaryBar();
		harness.layout.showPart('panel');
		assert.equal(harness.layout.isAuxiliaryBarMaximized(), false);
		assert.equal(harness.layout.isPartVisible('editor'), true);
		harness.layout.toggleMaximizedAuxiliaryBar();
		harness.layout.restoreWorkspaceState();
		assert.equal(harness.layout.isAuxiliaryBarMaximized(), true);
		assert.equal(harness.layout.isPartVisible('editor'), false);
	} finally {
		dom.window.close();
	}
});

test('Panel reopening remembers its closing state across layout recreation and keeps workspace state separate', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash-panel.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'first',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	try {
		const first = createLayoutHarness(dom.window.document, {
			storageService: storage,
			defaultLayout: { parts: { panel: true } },
		});
		first.layout.layout(new Dimension(1_200, 800));
		first.layout.resizePart('panel', new Dimension(first.layout.getPartSize('panel').width, 180));
		first.layout.toggleMaximizedPanel();
		first.layout.hidePart('panel');
		first.layout.hidePart('panel');
		await storage.flush(WillSaveStateReason.SHUTDOWN);
		first.disposables.dispose();

		const restored = createLayoutHarness(dom.window.document, { storageService: storage });
		using resources = restored.disposables;
		restored.layout.layout(new Dimension(1_200, 800));
		assert.equal(restored.layout.isPartVisible('panel'), false);
		restored.layout.showPart('panel');
		assert.equal(restored.layout.isPanelMaximized(), true);
		restored.layout.hidePart('panel');
		await storage.flush(WillSaveStateReason.WORKSPACE_CHANGE);
		await storage.switchWorkspace('second');
		restored.layout.restoreWorkspaceState();
		restored.layout.showPart('panel');
		assert.equal(restored.layout.isPanelMaximized(), false);
		await storage.switchWorkspace('first');
		restored.layout.restoreWorkspaceState();
		restored.layout.showPart('panel');
		assert.equal(restored.layout.isPanelMaximized(), true);
		restored.layout.toggleMaximizedPanel();
		assert.equal(restored.layout.getPartSize('panel').height, 180);
		restored.layout.hidePart('panel');
		restored.layout.showPart('panel');
		assert.equal(restored.layout.isPanelMaximized(), false);
	} finally {
		dom.window.close();
	}
});

test('Workbench layout state is versioned and excludes topology', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, { defaultLayout: { parts: { panel: true } } });
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.resizePart('sidebar', harness.layout.getPartSize('sidebar').with(250));
	harness.layout.hidePart('auxiliarybar');
	harness.layout.resizePart('agentSidebar', harness.layout.getPartSize('agentSidebar').with(300));
	harness.layout.showPart('agentSidebar');
	harness.layout.resizePart('panel', new Dimension(harness.layout.getPartSize('panel').width, 180));
	const state = harness.layout.state;

	assert.deepEqual(state, {
		version: 3,
		sidebar: { width: 250, visible: true },
		auxiliarybar: { width: 256, visible: false },
		agentSidebar: { width: 300, visible: true },
		panel: { position: Position.BOTTOM, width: 256, height: 180, visible: true },
	});
	assert.equal('children' in state, false);

	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench layout derives flexible editor size from the container', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		defaultLayout: { parts: { panel: true } },
	});
	harness.layout.layout(new Dimension(1_200, 800));

	assert.deepEqual(harness.layout.getPartSize('sidebar'), new Dimension(300, 730));
	assert.deepEqual(harness.layout.getPartSize('auxiliarybar'), new Dimension(300, 730));
	assert.deepEqual(harness.layout.getPartSize('editor'), new Dimension(548, 730 - 800 / 3));
	assert.equal(harness.layout.getPartSize('panel').height, 800 / 3);

	harness.layout.layout(new Dimension(1_300, 800));
	assert.equal(harness.layout.getPartSize('sidebar').width, 300);
	assert.equal(harness.layout.getPartSize('auxiliarybar').width, 300);
	assert.equal(harness.layout.getPartSize('editor').width, 648);

	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench sash reset keeps unrelated sidebars at their current widths', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, { initialDimension: new Dimension(1_200, 800) });
	harness.layout.layout(new Dimension(1_200, 800));
	harness.layout.resizePart('sidebar', harness.layout.getPartSize('sidebar').with(260));
	harness.layout.resizePart('auxiliarybar', harness.layout.getPartSize('auxiliarybar').with(320));
	const sidebarWidth = harness.layout.getPartSize('sidebar').width;

	resetWorkbenchSash(dom.window, harness.container, 'auxiliarybar', 1);

	assert.equal(harness.layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(harness.layout.getPartSize('editor').width, harness.layout.getPartSize('auxiliarybar').width);

	harness.disposables.dispose();
	dom.window.close();
});

test('Git sidebar uses its preferred reset width and merges a lone view into the title', async () => {
	const { SCMViewPaneContainer } = await import('../../../workbench/contrib/scm/browser/scmViewPaneContainer.js');
	class GitTestView extends ViewPane {
		readonly action: HTMLButtonElement;

		constructor(container: HTMLElement, options: IViewPaneOptions) {
			super(container, options);
			this.action = h(container.ownerDocument, 'button');
			this.action.textContent = 'Refresh';
			this.headerActionsElement.append(this.action);
		}
	}
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.git',
			title: 'Git',
			location: ViewContainerLocation.Sidebar,
			isDefault: true,
		}),
	);
	disposables.add(
		registry.registerViews('ash.git', [
			{ id: 'test.changes', title: 'Changes', collapsed: true, ctorDescriptor: new SyncDescriptor(GitTestView) },
			{ id: 'test.graph', title: 'Graph', ctorDescriptor: new SyncDescriptor(GitTestView) },
		]),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.Sidebar);
	assert.ok(descriptor);
	const model = viewDescriptors.getViewContainerModel(descriptor.id);
	const host = h(dom.window.document, 'main');
	const sidebar = registerContainerServices(componentServices).createInstance(SidebarPart, host, {
		openComposite: async () => null,
		viewDescriptorService: viewDescriptors,
		contextKeyService: contextKeys,
	});
	const composite = registerContainerServices(componentServices).createInstance(SCMViewPaneContainer, host, {
		viewContainer: descriptor,
		model,
	});
	sidebar.addComposite(composite);
	sidebar.showComposite(descriptor.id);
	const harness = createLayoutHarness(
		dom.window.document,
		{ initialDimension: new Dimension(1_200, 800) },
		host,
		sidebar,
	);
	harness.layout.layout(new Dimension(1_200, 800));
	harness.layout.resizePart('sidebar', harness.layout.getPartSize('sidebar').with(250));
	assert.equal(sidebar.preferredWidth, 400);
	resetWorkbenchSash(dom.window, host, 'sidebar', 0);
	assert.equal(harness.layout.getPartSize('sidebar').width, 402);

	const changes = composite.getView('test.changes') as GitTestView;
	const header = changes.element.querySelector<HTMLElement>('.ash-pane-view-header');
	const headerButton = changes.element.querySelector<HTMLElement>('.ash-pane-view-header-button');
	assert.ok(header);
	assert.ok(headerButton);
	assert.equal(changes.isExpanded(), false);
	assert.equal(sidebar.domNode.querySelector('.ash-sidebar-title-label')?.textContent, 'Git');
	headerButton.focus();
	assert.equal(dom.window.document.activeElement, headerButton);
	model.setVisible('test.graph', false);
	assert.equal(sidebar.domNode.querySelector('.ash-sidebar-title-label')?.textContent, 'Git: Changes');
	assert.equal(header.hidden, true);
	assert.equal(changes.element.getAttribute('aria-label'), 'Changes');
	assert.equal(changes.isBodyVisible(), true);
	assert.equal(dom.window.document.activeElement, changes.element);
	assert.equal(changes.action.closest('.ash-pane-composite-title-view-actions') !== null, true);
	changes.action.focus();
	model.setVisible('test.graph', true);
	assert.equal(sidebar.domNode.querySelector('.ash-sidebar-title-label')?.textContent, 'Git');
	assert.equal(header.hidden, false);
	assert.equal(changes.isExpanded(), false);
	assert.equal(changes.action.closest('.ash-pane-view-header') !== null, true);
	assert.equal(dom.window.document.activeElement, changes.action);
	harness.layout.setSideBarLocation('right');
	harness.layout.resizePart('sidebar', harness.layout.getPartSize('sidebar').with(250));
	resetWorkbenchSash(dom.window, host, 'sidebar', 2);
	assert.equal(harness.layout.getPartSize('sidebar').width, 402);

	harness.disposables.dispose();
	disposables.dispose();
	dom.window.close();
});

test('Workbench uses the product window size when the startup container has no geometry', () => {
	const dom = new JSDOM('');
	const harness = createLayoutHarness(dom.window.document, { initialDimension: undefined });
	harness.layout.layout(new Dimension(1200, 800));
	assert.equal(harness.layout.getPartSize('sidebar').width, 300);
	assert.equal(harness.layout.getPartSize('panel').height, 800 / 3);
	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench initializes widths from the viewport without rescaling restored dimensions', async () => {
	const dom = new JSDOM('', { url: 'https://layout-sizing.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'sizing',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	for (const width of [800, 1600]) {
		const harness = createLayoutHarness(dom.window.document, { initialDimension: new Dimension(width, 900) });
		harness.layout.layout(new Dimension(width, 900));
		assert.equal(harness.layout.getPartSize('sidebar').width, Math.min(300, width / 4));
		assert.equal(harness.layout.getPartSize('auxiliarybar').width, Math.min(300, width / 4));
		harness.disposables.dispose();
	}
	const first = createLayoutHarness(dom.window.document, {
		storageService: storage,
		initialDimension: new Dimension(1600, 900),
	});
	first.layout.layout(new Dimension(1600, 900));
	first.layout.resizePart('sidebar', new Dimension(420, 800));
	first.layout.hidePart('auxiliarybar');
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	first.disposables.dispose();
	const restored = createLayoutHarness(dom.window.document, {
		storageService: storage,
		initialDimension: new Dimension(1000, 700),
	});
	restored.layout.layout(new Dimension(1000, 700));
	assert.equal(restored.layout.getPartSize('sidebar').width, 420);
	assert.equal(restored.layout.isPartVisible('auxiliarybar'), false);
	restored.disposables.dispose();
	dom.window.close();
});

test('secondary side bar startup policies distinguish empty windows, workspaces, and disabled AI', () => {
	for (const [visibility, emptyVisible, folderVisible] of [
		['hidden', false, false],
		['visibleInWorkspace', false, true],
		['visible', true, true],
		['maximizedInWorkspace', false, true],
		['maximized', true, true],
	] as const) {
		for (const workbenchState of [WorkbenchState.EMPTY, WorkbenchState.FOLDER]) {
			const dom = new JSDOM('');
			const harness = createLayoutHarness(dom.window.document, {
				workbenchState,
				initialDimension: new Dimension(1200, 800),
				configurationValues: {
					'chat.disableAIFeatures': true,
					'workbench.secondarySideBar.defaultVisibility': visibility,
				},
			});
			const visible = workbenchState === WorkbenchState.EMPTY ? emptyVisible : folderVisible;
			assert.equal(harness.layout.isPartVisible('auxiliarybar'), visible, `${visibility}, ${workbenchState}`);
			assert.equal(harness.layout.isAuxiliaryBarMaximized(), visible && visibility.startsWith('maximized'));
			if (harness.layout.isAuxiliaryBarMaximized()) {
				assert.equal(harness.layout.isPartVisible('editor'), false);
				harness.layout.toggleMaximizedAuxiliaryBar();
				assert.equal(harness.layout.isPartVisible('editor'), true);
			}
			harness.disposables.dispose();
			dom.window.close();
		}
	}
});

test('forced secondary side bar maximization overrides saved visibility and responds to configuration', async () => {
	const dom = new JSDOM('', { url: 'https://layout-force.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'force',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	storage.store('workbench.layout.auxiliarybar.visible', false, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	const harness = createLayoutHarness(dom.window.document, {
		storageService: storage,
		initialDimension: new Dimension(1200, 800),
		configurationValues: { 'workbench.secondarySideBar.forceMaximized': true },
	});
	assert.equal(harness.layout.isAuxiliaryBarMaximized(), true);
	await harness.configuration.updateValue(WorkbenchConfiguration.secondarySideBarForceMaximized, false);
	assert.equal(harness.layout.isAuxiliaryBarMaximized(), false);
	assert.equal(harness.layout.isPartVisible('editor'), true);
	harness.disposables.dispose();
	dom.window.close();
});

test('Panel reveal honors always, never, and preserve instead of overriding the preference with saved state', () => {
	for (const mode of ['always', 'never', 'preserve'] as const) {
		for (const saved of [true, false]) {
			const dom = new JSDOM('', { url: 'https://panel-policy.test' });
			using storage = new BrowserStorageService({
				ownerWindow: dom.window as unknown as Window,
				workspaceId: 'panel',
				backend: dom.window.localStorage,
				flushInterval: 0,
			});
			storage.store(
				'workbench.layout.panel.wasLastMaximized',
				saved,
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
			const harness = createLayoutHarness(dom.window.document, {
				storageService: storage,
				configurationValues: { 'workbench.panel.opensMaximized': mode },
			});
			harness.layout.showPart('panel');
			assert.equal(harness.layout.isPanelMaximized(), mode === 'always' || (mode === 'preserve' && saved));
			harness.disposables.dispose();
			dom.window.close();
		}
	}
});

test('empty auxiliary bars stay closed unless visibility is explicitly configured', () => {
	const dom = new JSDOM('', { url: 'https://layout-empty.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'empty-views',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	storage.store('workbench.layout.auxiliarybar.empty', true, StorageScope.PROFILE, StorageTarget.MACHINE);
	const first = createLayoutHarness(dom.window.document, { storageService: storage });
	assert.equal(first.layout.isPartVisible('auxiliarybar'), false);
	first.disposables.dispose();
	const configured = createLayoutHarness(dom.window.document, {
		storageService: storage,
		configurationValues: { 'workbench.secondarySideBar.defaultVisibility': 'visible' },
	});
	assert.equal(configured.layout.isPartVisible('auxiliarybar'), true);
	configured.disposables.dispose();
	dom.window.close();
});

test('saved auxiliary maximization wins over default policy when the layout is recreated', async () => {
	const dom = new JSDOM('', { url: 'https://layout-maximize.test' });
	using storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'maximized',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const options = {
		storageService: storage,
		initialDimension: new Dimension(1200, 800),
		configurationValues: { 'workbench.secondarySideBar.defaultVisibility': 'maximized' },
	};
	const first = createLayoutHarness(dom.window.document, options);
	first.layout.layout(new Dimension(1200, 800));
	assert.equal(first.layout.isAuxiliaryBarMaximized(), true);
	first.layout.setAuxiliaryBarMaximized(false);
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	first.disposables.dispose();
	const restored = createLayoutHarness(dom.window.document, options);
	assert.equal(restored.layout.isAuxiliaryBarMaximized(), false);
	restored.disposables.dispose();
	dom.window.close();
});

test('Workbench layout applies host defaults without exposing persisted state', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		defaultLayout: { parts: { sidebar: false, auxiliarybar: false, agentSidebar: false, panel: false } },
	});
	harness.layout.layout(new Dimension(1_200, 800));

	assert.equal(harness.layout.getPartSize('sidebar').width, 300);
	assert.equal(harness.layout.getPartSize('auxiliarybar').width, 300);
	assert.equal(harness.layout.getPartSize('panel').height, 800 / 3);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), false);
	assert.equal(harness.layout.isPartVisible('sidebar'), false);
	assert.equal(harness.layout.isPartVisible('panel'), false);

	harness.disposables.dispose();
	dom.window.close();
});

test('new profiles show the auxiliary bar in empty windows and restore saved visibility', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const createStorage = (workspaceId: string) =>
		new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId,
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
	const firstStorage = createStorage('empty-a');
	const first = createLayoutHarness(dom.window.document, {
		workbenchState: WorkbenchState.EMPTY,
		storageService: firstStorage,
	});
	assert.deepEqual(
		[
			first.layout.isPartVisible('sidebar'),
			first.layout.isPartVisible('auxiliarybar'),
			first.layout.isPartVisible('panel'),
		],
		[false, true, false],
	);
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.disposables.dispose();
	firstStorage.dispose();

	const storage = createStorage('empty-b');
	assert.equal(storage.isNew(StorageScope.APPLICATION), true);
	const restored = createLayoutHarness(dom.window.document, {
		workbenchState: WorkbenchState.EMPTY,
		storageService: storage,
	});
	assert.deepEqual(
		[restored.layout.isPartVisible('sidebar'), restored.layout.isPartVisible('auxiliarybar')],
		[false, true],
	);
	restored.layout.showPart('sidebar');
	restored.layout.showPart('auxiliarybar');
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	restored.disposables.dispose();
	storage.dispose();

	const savedEmptyStorage = createStorage('empty-b');
	const savedEmpty = createLayoutHarness(dom.window.document, {
		workbenchState: WorkbenchState.EMPTY,
		storageService: savedEmptyStorage,
	});
	assert.deepEqual(
		[savedEmpty.layout.isPartVisible('sidebar'), savedEmpty.layout.isPartVisible('auxiliarybar')],
		[true, true],
	);
	savedEmptyStorage.switchWorkspace('empty-c');
	savedEmpty.layout.restoreWorkspaceState(WorkbenchState.EMPTY);
	assert.deepEqual(
		[savedEmpty.layout.isPartVisible('sidebar'), savedEmpty.layout.isPartVisible('auxiliarybar')],
		[false, true],
	);
	savedEmptyStorage.switchWorkspace('folder-a');
	savedEmpty.layout.restoreWorkspaceState(WorkbenchState.FOLDER);
	assert.deepEqual(
		[
			savedEmpty.layout.isPartVisible('sidebar'),
			savedEmpty.layout.isPartVisible('auxiliarybar'),
			savedEmpty.layout.isPartVisible('panel'),
		],
		[true, true, false],
	);
	savedEmpty.layout.hidePart('auxiliarybar');
	await savedEmptyStorage.flush(WillSaveStateReason.SHUTDOWN);
	savedEmpty.disposables.dispose();
	savedEmptyStorage.dispose();

	const savedStorage = createStorage('folder-a');
	const saved = createLayoutHarness(dom.window.document, {
		workbenchState: WorkbenchState.FOLDER,
		storageService: savedStorage,
	});
	assert.equal(saved.layout.isPartVisible('sidebar'), true);
	assert.equal(saved.layout.isPartVisible('auxiliarybar'), false);
	saved.disposables.dispose();
	savedStorage.dispose();
	dom.window.close();
});

test('Workbench default layout applies to new workspaces unless forced', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const createStorage = (workspaceId: string) =>
		new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId,
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
	const initialDimension = new Dimension(1_000, 700);
	const seedStorage = createStorage('workspace-a');
	const seed = createLayoutHarness(dom.window.document, { initialDimension, storageService: seedStorage });
	assert.equal(seed.layout.isPartVisible('sidebar'), true);
	await seedStorage.flush(WillSaveStateReason.SHUTDOWN);
	seed.disposables.dispose();
	seedStorage.dispose();

	const storage = createStorage('workspace-a');
	const restored = createLayoutHarness(dom.window.document, {
		initialDimension,
		defaultLayout: { parts: { sidebar: false } },
		storageService: storage,
	});
	assert.equal(storage.isNew(StorageScope.WORKSPACE), false);
	assert.equal(restored.layout.isPartVisible('sidebar'), true);
	storage.switchWorkspace('workspace-b');
	restored.layout.restoreWorkspaceState();
	assert.equal(storage.isNew(StorageScope.WORKSPACE), true);
	assert.equal(restored.layout.isPartVisible('sidebar'), false);
	storage.switchWorkspace('workspace-a');
	restored.layout.restoreWorkspaceState();
	assert.equal(restored.layout.isPartVisible('sidebar'), true);
	restored.disposables.dispose();
	storage.dispose();

	const forcedStorage = createStorage('workspace-a');
	const forced = createLayoutHarness(dom.window.document, {
		initialDimension,
		defaultLayout: { parts: { sidebar: false }, force: true },
		storageService: forcedStorage,
	});
	assert.equal(forced.layout.isPartVisible('sidebar'), false);
	assert.equal(forced.layout.isPartVisible('panel'), false);
	forced.disposables.dispose();
	forcedStorage.dispose();
	dom.window.close();
});

test('Workbench layout validates and restores mutable state only', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document);
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.restoreState({
		version: 2,
		sidebar: { width: 260, visible: true },
		auxiliarybar: { width: 240, visible: false },
		panel: { height: 160, visible: false },
	});

	assert.equal(harness.layout.getPartSize('sidebar').width, 260);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), false);
	assert.equal(harness.layout.isPartVisible('panel'), false);
	harness.layout.restoreState({
		version: 1,
		sidebar: { width: 250, visible: true },
		auxiliarybar: { width: 230, visible: true },
	});
	assert.equal(harness.layout.getPartSize('panel').height, 300);
	assert.equal(harness.layout.isPartVisible('panel'), true);
	assert.throws(
		() =>
			harness.layout.restoreState({
				version: 3,
				sidebar: { width: 260, visible: true },
				auxiliarybar: { width: 240, visible: false },
				panel: { height: 160, visible: false },
			}),
		/invalid or unsupported/,
	);

	harness.disposables.dispose();
	dom.window.close();
});

test('Workbench layout restores scoped state through the storage service', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const createStorage = (workspaceId: string) =>
		new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId,
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
	const firstStorage = createStorage('workspace-a');
	const first = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: firstStorage,
	});
	first.layout.layout(new Dimension(1_000, 700));
	first.layout.resizePart('auxiliarybar', first.layout.getPartSize('auxiliarybar').with(310));
	first.layout.hidePart('auxiliarybar');
	first.layout.resizePart('panel', new Dimension(first.layout.getPartSize('panel').width, 175));
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.disposables.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage('workspace-a');
	const restored = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: restoredStorage,
	});
	restored.layout.layout(new Dimension(1_000, 700));
	assert.equal(restored.layout.getPartSize('auxiliarybar').width, 310);
	assert.equal(restored.layout.isPartVisible('auxiliarybar'), false);
	assert.equal(restored.layout.getPartSize('panel').height, 175);
	restored.disposables.dispose();
	restoredStorage.dispose();

	const otherWorkspaceStorage = createStorage('workspace-b');
	const otherWorkspace = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: otherWorkspaceStorage,
	});
	otherWorkspace.layout.layout(new Dimension(1_000, 700));
	assert.equal(otherWorkspace.layout.getPartSize('auxiliarybar').width, 310);
	assert.equal(otherWorkspace.layout.isPartVisible('auxiliarybar'), true);
	assert.equal(otherWorkspace.layout.getPartSize('panel').height, 175);

	otherWorkspace.disposables.dispose();
	otherWorkspaceStorage.dispose();
	dom.window.close();
});

test('Workbench layout re-applies the active workspace state after storage switches', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'workspace-a',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: storage,
	});
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.hidePart('auxiliarybar');
	await storage.flush(WillSaveStateReason.SHUTDOWN);

	storage.switchWorkspace('workspace-b');
	harness.layout.restoreWorkspaceState();
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), true);

	storage.switchWorkspace('workspace-a');
	harness.layout.restoreWorkspaceState();
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), false);

	harness.disposables.dispose();
	storage.dispose();
	dom.window.close();
});

test('Workbench layout retains resized Part dimensions across visibility', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document);
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.resizePart('sidebar', harness.layout.getPartSize('sidebar').with(250));
	assert.equal(harness.layout.getPartSize('sidebar').width, 250);
	harness.layout.hidePart('sidebar');
	harness.layout.showPart('sidebar');
	assert.equal(harness.layout.getPartSize('sidebar').width, 250);
	const restoredSidebarPane =
		harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement?.parentElement;
	assert.equal(restoredSidebarPane?.style.width, '250px');

	harness.disposables.dispose();
	dom.window.close();
});

test('Activity Bar hosts the primary sidebar selector independently of sidebar visibility', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.explorer',
			title: 'Explorer',
			location: ViewContainerLocation.Sidebar,
			order: 1,
			isDefault: true,
		}),
	);
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.search',
			title: 'Search',
			location: ViewContainerLocation.Sidebar,
			order: 2,
		}),
	);
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.git',
			title: 'Git',
			location: ViewContainerLocation.Sidebar,
			order: 3,
		}),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const sidebar = disposables.add(
		registerContainerServices(componentServices).createInstance(SidebarPart, dom.window.document.body, {
			openComposite: async (id: string) => {
				selections.push(id);
				return null;
			},
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
		}),
	);
	dom.window.document.body.append(sidebar.domNode);
	const compositeBar = sidebar.compositeBar;
	const globalActions = dom.window.document.createElement('div');
	const configuration = disposables.add(new InMemoryConfigurationService());
	const globalBar = { domNode: globalActions, setOrientation() {}, getContextMenuActions: () => [] };
	const localization = {
		translate: (_bundle: string, _key: string, fallback: string) => fallback,
	} as ILocalizationService;
	const activitybar = disposables.add(
		createTestActivitybar(dom.window.document.body, compositeBar, globalBar, configuration, localization),
	);
	assert.equal(activitybar.minimumWidth, 44);
	activitybar.setLayoutStyle('flat');
	assert.equal(activitybar.minimumWidth, 48);
	activitybar.setLayoutStyle('modern');
	activitybar.setCompact(true);
	assert.equal(activitybar.minimumWidth, 36);
	assert.equal(compositeBar.domNode.classList.contains('compact'), true);
	activitybar.setCompact(false);
	assert.equal(compositeBar.domNode.classList.contains('compact'), false);
	activitybar.setSidebarVisible(true);
	assert.equal(activitybar.domNode.classList.contains('sidebar-open'), true);
	activitybar.setSidebarVisible(false);
	assert.equal(activitybar.domNode.classList.contains('sidebar-open'), false);
	const selections: string[] = [];

	assert.equal(compositeBar.domNode.querySelectorAll('.ash-action-view-item').length, 3);
	assert.deepEqual(
		[...compositeBar.domNode.querySelectorAll<HTMLElement>('.ash-action-view-item')].map(
			item => item.dataset.actionId,
		),
		['ash.explorer', 'ash.search', 'ash.git'],
	);
	const title = sidebar.domNode.querySelector(':scope > .ash-workbench-part-title.ash-pane-composite-title');
	assert.ok(title);
	assert.equal(compositeBar.domNode.parentElement, activitybar.domNode.querySelector('.ash-workbench-part-content'));
	assert.equal(globalActions.parentElement, activitybar.domNode.querySelector('.ash-workbench-part-content'));
	assert.equal(title?.parentElement, sidebar.domNode);
	sidebar.setActivityBarLocation(ActivityBarPosition.TOP);
	assert.equal(compositeBar.domNode.parentElement, sidebar.domNode.querySelector('.ash-sidebar-composite-bar-top'));
	assert.equal(
		compositeBar.domNode.querySelector('[role="tablist"]')?.getAttribute('aria-orientation'),
		'horizontal',
	);
	sidebar.setActivityBarLocation(ActivityBarPosition.BOTTOM);
	assert.equal(
		compositeBar.domNode.parentElement,
		sidebar.domNode.querySelector('.ash-sidebar-composite-bar-bottom'),
	);
	sidebar.setActivityBarLocation(ActivityBarPosition.DEFAULT);
	activitybar.hostCompositeBar();
	assert.equal(compositeBar.domNode.parentElement, activitybar.domNode.querySelector('.ash-workbench-part-content'));
	assert.equal(compositeBar.domNode.querySelector('[role="tablist"]')?.getAttribute('aria-orientation'), 'vertical');
	assert.equal(title.textContent, '');
	assert.equal(compositeBar.domNode.className, 'ash-composite-bar ash-composite-bar-icon ash-composite-bar-vertical');
	const content = sidebar.domNode.querySelector(':scope > .ash-composite-content');
	assert.ok(content);
	assert.equal(title.nextElementSibling, content);
	const actionbar = compositeBar.domNode.querySelector(':scope > .ash-action-bar');
	assert.equal(actionbar?.classList.contains('ash-action-bar'), true);
	assert.equal(actionbar?.classList.contains('vertical'), true);
	assert.equal(actionbar?.getAttribute('role'), 'tablist');
	assert.equal(actionbar?.getAttribute('aria-orientation'), 'vertical');
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(item => item.classList.contains('ash-tab')),
		[false, false, false],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(item => item.classList.contains('ash-composite-bar-item')),
		[true, true, true],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(item => item.getAttribute('role')),
		['tab', 'tab', 'tab'],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(item => item.firstElementChild?.getAttribute('role')),
		[null, null, null],
	);
	assert.equal(compositeBar.domNode.querySelectorAll('.ash-action-bar > .ash-action-view-item').length, 3);
	assert.equal(compositeBar.domNode.querySelectorAll('.ash-action-view-item > .ash-composite-bar-action').length, 3);
	assert.equal(compositeBar.domNode.querySelectorAll('button').length, 0);
	assert.equal(compositeBar.domNode.querySelector('.ash-tab-list'), null);
	assert.equal(compositeBar.domNode.hasAttribute('data-part'), false);
	assert.equal(compositeBar.domNode.querySelector('.ash-workbench-part-content'), null);
	compositeBar.setActiveComposite('ash.explorer');
	const explorerTab = compositeBar.domNode.querySelector<HTMLElement>("[data-action-id='ash.explorer'][role='tab']");
	const searchTab = compositeBar.domNode.querySelector<HTMLElement>("[data-action-id='ash.search'][role='tab']");
	assert.ok(explorerTab);
	assert.ok(searchTab);
	assert.equal(explorerTab.getAttribute('aria-selected'), 'true');
	explorerTab.focus();
	explorerTab.dispatchEvent(
		new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }),
	);
	assert.equal(dom.window.document.activeElement, searchTab);
	assert.deepEqual(selections, []);
	explorerTab.click();
	assert.deepEqual(selections, ['ash.explorer']);
	searchTab.click();
	assert.deepEqual(selections, ['ash.explorer', 'ash.search']);
	assert.equal(compositeBar.activeCompositeId, 'ash.explorer');

	const explorerContainer = viewDescriptors.getViewContainers(ViewContainerLocation.Sidebar)[0];
	const searchContainer = viewDescriptors.getViewContainers(ViewContainerLocation.Sidebar)[1];
	const explorerComposite = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{ viewContainer: explorerContainer, model: viewDescriptors.getViewContainerModel(explorerContainer.id) },
	);
	const searchComposite = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{ viewContainer: searchContainer, model: viewDescriptors.getViewContainerModel(searchContainer.id) },
	);
	sidebar.addComposite(explorerComposite);
	sidebar.addComposite(searchComposite);
	sidebar.showComposite(explorerComposite.id);
	assert.equal(title.textContent, 'Explorer');
	assert.equal(sidebar.activeCompositeId, explorerComposite.id);
	assert.equal(contextKeys.getValue('activeViewlet'), explorerComposite.id);
	assert.equal(explorerComposite.element.hidden, false);
	assert.equal(searchComposite.element.hidden, true);
	sidebar.showComposite(searchComposite.id);
	assert.equal(sidebar.activeCompositeId, searchComposite.id);
	assert.equal(contextKeys.getValue('activeViewlet'), searchComposite.id);
	assert.equal(explorerComposite.element.hidden, true);
	assert.equal(searchComposite.element.hidden, false);
	sidebar.showComposite(explorerComposite.id);
	assert.equal(sidebar.getComposite(explorerComposite.id), explorerComposite);
	assert.equal(explorerComposite.element.hidden, false);
	assert.equal(contextKeys.getValue('activeViewlet'), explorerComposite.id);

	disposables.dispose();
	dom.window.close();
});

test('CompositeBar retains selectors and keyboard focus through selection and unrelated badge updates', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using resources = new DisposableStore();
		const registry = resources.add(new WorkbenchViewRegistry());
		for (const id of ['first', 'second', 'third']) {
			resources.add(registry.registerViewContainer({ id, title: id, location: ViewContainerLocation.Sidebar }));
		}
		const contexts = resources.add(new ContextKeyService());
		const views = resources.add(new TestViewDescriptorService({ registry }, contexts));
		const activity = resources.add(new ActivityService(views));
		const opened: string[] = [];
		const bar = resources.add(
			new CompositeBar(
				dom.window.document.body,
				{
					overflowActionSize: 22,
					orientation: 'vertical',
					location: ViewContainerLocation.Sidebar,
					ariaLabel: 'Views',
					viewDescriptorService: views,
					activityHoverOptions: { position: () => HoverPosition.RIGHT },
					contextMenuProvider: { showContextMenu() {} },
					openComposite: async id => {
						opened.push(id);
						bar.setActiveComposite(id);
						return null;
					},
				},
				activity,
			),
		);
		const tabs = [...bar.domNode.querySelectorAll<HTMLElement>('[role="tab"]')];
		bar.setActiveComposite('first');
		tabs[1]!.focus();
		tabs[1]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
		);
		assert.deepEqual(opened, ['second']);
		assert.deepEqual([...bar.domNode.querySelectorAll('[role="tab"]')], tabs);
		assert.deepEqual(
			tabs.map(tab => [tab.getAttribute('aria-selected'), tab.tabIndex]),
			[
				['false', -1],
				['true', 0],
				['false', -1],
			],
		);
		assert.equal(dom.window.document.activeElement, tabs[1]);
		using badge = activity.showViewContainerActivity('third', { badge: new NumberBadge(3, () => '3 changes') });
		assert.equal(bar.domNode.querySelector('[data-action-id="second"]'), tabs[1]);
		assert.equal(dom.window.document.activeElement, tabs[1]);
		assert.equal(bar.domNode.querySelector('[data-action-id="third"] .ash-count-badge')?.textContent, '3');
		bar.setActiveComposite(undefined);
		bar.setActiveComposite('first');
		assert.equal(bar.domNode.querySelector('[data-action-id="first"]'), tabs[0]);
		tabs[1]!.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
		);
		assert.equal(dom.window.document.activeElement?.getAttribute('data-action-id'), 'third');
	} finally {
		dom.window.close();
	}
});

test('CompositePart only redistributes changed constraints and publishes each active allocation once', async () => {
	const { CompositePart } = await import('../../browser/parts/compositePart.js');
	const { Composite } = await import('../../browser/composite.js');
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using resources = new DisposableStore();
		const services = resources.add(createTestComponentServices(undefined, undefined, dom.window.document));
		class MeasuredComposite extends Composite {
			readonly allocations: { width: number; height: number }[] = [];
			constructor(
				readonly id: string,
				private readonly width: number,
			) {
				super(id, services.get(IThemeService), services.get(IStorageService));
				const root = dom.window.document.createElement('div');
				this.create(root);
				this._register(toDisposable(() => root.remove()));
			}
			override get minimumWidth(): number {
				return this.width;
			}
			focus(): void {}
			layout(dimension: { width: number; height: number }): void {
				this.allocations.push({ ...dimension });
			}
		}
		class MeasuredPart extends CompositePart<MeasuredComposite> {
			constructor() {
				super(dom.window.document.body, 'measured', services.get(IThemeService), services.get(IStorageService));
			}
			get content(): HTMLElement {
				return this.contentDomNode;
			}
		}
		const part = resources.add(new MeasuredPart());
		let width = 640;
		Object.defineProperties(part.content, { clientWidth: { get: () => width }, clientHeight: { get: () => 400 } });
		const first = new MeasuredComposite('first', 0);
		const second = new MeasuredComposite('second', 0);
		const wide = new MeasuredComposite('wide', 420);
		for (const composite of [first, second, wide]) part.addComposite(composite);
		const constraints: number[] = [];
		resources.add(
			part.onDidChangeConstraints(() => {
				constraints.push(part.minimumWidth);
				part.layout(new Dimension(width, 400));
			}),
		);
		part.showComposite('first');
		part.showComposite('second');
		assert.deepEqual(constraints, []);
		part.showComposite('wide');
		assert.deepEqual(constraints, [420]);
		assert.deepEqual(wide.allocations, [{ width: 640, height: 400 }]);
		part.layout(new Dimension(width, 400));
		part.showComposite('wide');
		assert.equal(wide.allocations.length, 1);
		width = 720;
		part.layout(new Dimension(width, 400));
		assert.deepEqual(wide.allocations.at(-1), { width: 720, height: 400 });
		part.setVisible(false);
		part.setVisible(true);
		assert.equal(wide.allocations.length, 3, 'A reopened body receives its current allocation');
		part.showComposite('first');
		assert.deepEqual(constraints, [420, 0]);
		assert.deepEqual(first.allocations.at(-1), { width: 720, height: 400 });
	} finally {
		dom.window.close();
	}
});

test('Pane Composite Parts restore workspace selections with Registry fallback', () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.explorer',
			title: 'Explorer',
			location: ViewContainerLocation.Sidebar,
			isDefault: true,
		}),
	);
	disposables.add(
		registry.registerViewContainer({ id: 'ash.search', title: 'Search', location: ViewContainerLocation.Sidebar }),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const createStorage = (workspaceId: string) =>
		new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId,
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
	const createComposite = (containerId: string) => {
		const descriptor = viewDescriptors
			.getViewContainers(ViewContainerLocation.Sidebar)
			.find(candidate => candidate.id === containerId);
		assert.ok(descriptor);
		return registerContainerServices(componentServices).createInstance(PaneComposite, dom.window.document.body, {
			viewContainer: descriptor,
			model: viewDescriptors.getViewContainerModel(descriptor.id),
		});
	};

	const firstStorage = createStorage('workspace-a');
	using firstServices = createTestComponentServices(firstStorage, undefined, dom.window.document);
	firstServices.registerInstance(IWorkbenchLayoutService, {
		getSideBarPosition: () => Position.LEFT,
	} as import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService);
	firstServices.registerInstance(IViewDescriptorService, viewDescriptors);
	const first = registerContainerServices(firstServices).createInstance(SidebarPart, dom.window.document.body, {
		openComposite: async () => null,
		viewDescriptorService: viewDescriptors,
	});
	assert.equal(first.getCompositeIdToRestore(), 'ash.explorer');
	const search = createComposite('ash.search');
	first.addComposite(search);
	first.showComposite(search.id);
	first.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage('workspace-a');
	using restoredServices = createTestComponentServices(restoredStorage, undefined, dom.window.document);
	restoredServices.registerInstance(IWorkbenchLayoutService, {
		getSideBarPosition: () => Position.LEFT,
	} as import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService);
	restoredServices.registerInstance(IViewDescriptorService, viewDescriptors);
	const restored = registerContainerServices(restoredServices).createInstance(SidebarPart, dom.window.document.body, {
		openComposite: async () => null,
		viewDescriptorService: viewDescriptors,
	});
	assert.equal(restored.getCompositeIdToRestore(), 'ash.search');
	restoredStorage.switchWorkspace('workspace-b');
	assert.equal(restored.getCompositeIdToRestore(), 'ash.explorer');
	restoredStorage.switchWorkspace('workspace-a');
	assert.equal(restored.getCompositeIdToRestore(), 'ash.search');
	const explorer = createComposite('ash.explorer');
	restored.addComposite(explorer);
	restored.showComposite(explorer.id);
	restored.dispose();
	restoredStorage.dispose();

	const defaultStorage = createStorage('workspace-a');
	using fallbackServices = createTestComponentServices(defaultStorage, undefined, dom.window.document);
	fallbackServices.registerInstance(IWorkbenchLayoutService, {
		getSideBarPosition: () => Position.LEFT,
	} as import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService);
	fallbackServices.registerInstance(IViewDescriptorService, viewDescriptors);
	const fallback = registerContainerServices(fallbackServices).createInstance(SidebarPart, dom.window.document.body, {
		openComposite: async () => null,
		viewDescriptorService: viewDescriptors,
	});
	assert.equal(fallback.getCompositeIdToRestore(), 'ash.explorer');
	fallback.dispose();
	defaultStorage.dispose();
	disposables.dispose();
	dom.window.close();
});

test('Sidebar can host Agent Sidebar composites', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.chat',
			title: 'Chat',
			location: ViewContainerLocation.AgentSidebar,
			isDefault: true,
		}),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const agentSidebar = disposables.add(
		registerContainerServices(componentServices).createInstance(SidebarPart, dom.window.document.body, {
			openComposite: async () => null,
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
			id: 'agentSidebar',
			location: ViewContainerLocation.AgentSidebar,
			ariaLabel: 'Agent sidebar',
			viewsAriaLabel: 'Agent sidebar views',
			compositeBarContainerFilter: () => false,
		}),
	);

	assert.equal(agentSidebar.domNode.dataset.part, 'agentSidebar');
	assert.equal(agentSidebar.domNode.getAttribute('aria-label'), 'Agent sidebar');
	assert.equal(agentSidebar.compositeBar.domNode.hidden, false);
	assert.equal(agentSidebar.compositeBar.domNode.querySelector("[data-action-id='ash.chat']"), null);
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.AgentSidebar);
	assert.ok(descriptor);
	const composite = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{ viewContainer: descriptor, model: viewDescriptors.getViewContainerModel(descriptor.id) },
	);
	agentSidebar.addComposite(composite);
	agentSidebar.showComposite(composite.id);
	assert.equal(contextKeys.getValue('activeAgentSidebar'), composite.id);

	disposables.dispose();
	dom.window.close();
});

test('Panel presents its destinations as tabs and active commands as a toolbar', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	const panels = [
		['ash.panel.problems', 'Problems'],
		['ash.panel.output', 'Output'],
		['ash.panel.terminal', 'Terminal'],
		['ash.panel.ports', 'Ports'],
	] as const;
	for (const [id, title] of panels) {
		disposables.add(
			registry.registerViewContainer({
				id,
				title,
				location: ViewContainerLocation.Panel,
				order: panels.findIndex(([candidate]) => candidate === id),
				isDefault: title === 'Terminal',
			}),
		);
	}
	disposables.add(
		registry.registerViews('ash.panel.terminal', [
			{ id: 'ash.terminal', title: 'Terminal', ctorDescriptor: new SyncDescriptor(TestPanelView) },
		]),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(new InstantiationService()));
	const menuService = new MenuService(commands, contextKeys);
	const contextMenuProvider: IContextMenuProvider = { showContextMenu() {} };
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const panelServices = disposables.add(new InstantiationService());
	assert.throws(() => panelServices.createInstance(PanelPart, dom.window.document.body), /viewDescriptorService/);
	panelServices.registerInstance(IViewDescriptorService, viewDescriptors);
	panelServices.registerInstance(IContextKeyService, contextKeys);
	panelServices.registerInstance(IStorageService, paneStorage);
	panelServices.registerInstance(PanelLocalizationService, {
		whenReady: Promise.resolve(),
		translate: (_bundle, _key, source) => source,
	});
	panelServices.registerInstance(IMenuService, menuService);
	assert.throws(() => panelServices.createInstance(PanelPart, dom.window.document.body), /contextMenuService/);
	panelServices.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		...contextMenuProvider,
		onDidShowContextMenu: BaseEvent.None,
		onDidHideContextMenu: BaseEvent.None,
		hideContextMenu() {},
	});
	const panel = disposables.add(
		registerContainerServices(panelServices).createInstance(PanelPart, dom.window.document.body),
	);
	assert.deepEqual([panel.minimumWidth, panel.minimumHeight], [300, 77]);
	dom.window.document.body.append(panel.domNode);

	const tablist = panel.domNode.querySelector(".ash-panel-title-control [role='tablist']");
	assert.equal(
		panel.compositeBar.domNode.className,
		'ash-composite-bar ash-composite-bar-label ash-composite-bar-horizontal',
	);
	assert.equal(tablist?.getAttribute('aria-label'), 'Panel views');
	assert.deepEqual(
		[...(tablist?.querySelectorAll("[role='tab']") ?? [])].map(tab => tab.textContent),
		['Problems', 'Output', 'Terminal', 'Ports'],
	);
	const panelToolbar = panel.domNode.querySelector(".ash-pane-composite-title-part-actions [role='toolbar']");
	assert.ok(panelToolbar);
	const maximizePanel = [...panelToolbar.querySelectorAll('button')].find(
		button => button.textContent === 'Maximize Panel',
	);
	const closePanel = [...panelToolbar.querySelectorAll('button')].find(
		button => button.textContent === 'Close Panel',
	);
	assert.ok(maximizePanel);
	assert.ok(closePanel);
	assert.ok(maximizePanel.querySelector('.ash-icon'));
	assert.ok(closePanel.querySelector('.ash-icon'));
	assert.equal(
		maximizePanel.compareDocumentPosition(closePanel) & browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING,
		browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING,
	);

	const terminalDescriptor = viewDescriptors
		.getViewContainers(ViewContainerLocation.Panel)
		.find(container => container.id === 'ash.panel.terminal');
	assert.ok(terminalDescriptor);
	const terminal = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{
			viewContainer: terminalDescriptor,
			model: viewDescriptors.getViewContainerModel(terminalDescriptor.id),
			paneHeaders: 'hidden',
			paneLayout: 'fill',
		},
	);
	panel.addComposite(terminal);
	panel.showComposite(terminal.id);
	assert.equal(contextKeys.getValue('activePanel'), terminal.id);

	const toolbar = panel.domNode.querySelector(
		".ash-pane-composite-title-view-actions [role='toolbar'][aria-label='Test panel actions']",
	);
	const terminalTab = panel.domNode.querySelector("[role='tab'][aria-selected='true']");
	assert.equal(toolbar?.getAttribute('aria-label'), 'Test panel actions');
	assert.equal(toolbar?.querySelector('button')?.textContent, 'Run');
	assert.equal(panel.domNode.querySelectorAll(".ash-panel-title-control [role='tablist']").length, 1);
	assert.equal(terminal.element.getAttribute('role'), 'tabpanel');
	assert.equal(terminal.element.classList.contains('ash-pane-composite-pane-headers-hidden'), true);
	assert.equal(terminal.element.classList.contains('ash-pane-composite-pane-layout-fill'), true);
	assert.equal(terminalTab?.getAttribute('aria-controls'), terminal.element.id);
	assert.equal(terminal.element.getAttribute('aria-labelledby'), terminalTab?.id);

	for (const panelId of ['ash.panel.problems', 'ash.panel.output', 'ash.panel.ports']) {
		const descriptor = viewDescriptors
			.getViewContainers(ViewContainerLocation.Panel)
			.find(container => container.id === panelId);
		assert.ok(descriptor);
		const composite = registerContainerServices(componentServices).createInstance(
			PaneComposite,
			dom.window.document.body,
			{
				viewContainer: descriptor,
				model: viewDescriptors.getViewContainerModel(descriptor.id),
				paneHeaders: 'hidden',
				paneLayout: 'fill',
			},
		);
		panel.addComposite(composite);
		panel.showComposite(composite.id);
		assert.equal(
			panel.domNode.querySelector(".ash-pane-composite-title-view-actions [aria-label='Test panel actions']"),
			null,
		);
		assert.equal(panelToolbar.isConnected, true);
		assert.ok([...panelToolbar.querySelectorAll('button')].some(button => button.textContent === 'Maximize Panel'));
		assert.ok([...panelToolbar.querySelectorAll('button')].some(button => button.textContent === 'Close Panel'));
	}

	disposables.dispose();
	dom.window.close();
});

test('Transient view navigation follows its active session and ignores stale restoration', async () => {
	const { StorageTarget } = await import('../../../platform/storage/common/storage.js');
	using resources = new DisposableStore();
	const registry = resources.add(new WorkbenchViewRegistry());
	registry.registerStaticViewContainer({
		id: 'test.output',
		title: 'Output',
		location: ViewContainerLocation.Panel,
		isDefault: true,
	});
	const previewId = 'test.preview';
	registry.registerStaticViewContainer({
		id: previewId,
		title: 'Preview',
		location: ViewContainerLocation.Panel,
		hideIfEmpty: true,
	});
	registry.registerStaticViews(previewId, [
		{
			id: 'test.preview.view',
			title: 'Preview',
			when: ContextKeyExpr.has('test.preview.enabled'),
			ctorDescriptor: new SyncDescriptor(TestRuntimeView),
		},
	]);
	const context = resources.add(new ContextKeyService());
	const enabled = context.createKey<boolean>('test.preview.enabled', false);
	const descriptors = resources.add(new TestViewDescriptorService({ registry }, context));
	const services = resources.add(createTestComponentServices());
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IViewDescriptorService, descriptors);
	services.registerInstance(PanelLocalizationService, {
		whenReady: Promise.resolve(),
		translate: (_bundle, _key, fallback) => fallback,
	});
	const commands = resources.add(new CommandService(services));
	services.registerInstance(IMenuService, new MenuService(commands, context));
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		showContextMenu() {},
		hideContextMenu() {},
		onDidShowContextMenu: BaseEvent.None,
		onDidHideContextMenu: BaseEvent.None,
	});
	const panel = resources.add(services.createInstance(PanelPart, browserEnvironment.window.document.body));
	const tabs = () =>
		[...panel.compositeBar.domNode.querySelectorAll<HTMLElement>('[role="tab"]')].map(tab => tab.dataset.actionId);
	const model = descriptors.getViewContainerModel(previewId);
	const baseTabs = tabs();
	const fallback = panel.getCompositeIdToRestore();
	const activeTabs = descriptors.getViewContainers(ViewContainerLocation.Panel).map(container => container.id);
	assert.equal(baseTabs.includes(previewId), false);
	services
		.get(IStorageService)
		.store('workbench.panel.activeViewContainer', previewId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.deepEqual({ tabs: tabs(), restore: panel.getCompositeIdToRestore() }, { tabs: baseTabs, restore: fallback });
	for (let session = 0; session < 2; session++) {
		enabled.set(true);
		assert.deepEqual(
			{
				tabs: tabs(),
				visible: model.visibleViewDescriptors.map(view => view.id),
				restore: panel.getCompositeIdToRestore(),
			},
			{ tabs: activeTabs, visible: ['test.preview.view'], restore: previewId },
		);
		panel.compositeBar.setActiveComposite(previewId);
		enabled.set(false);
		assert.deepEqual(
			{ tabs: tabs(), restore: panel.getCompositeIdToRestore() },
			{ tabs: baseTabs, restore: fallback },
		);
	}
});

for (const [overflowActionSize, availableWidth] of [
	[22, 110],
	[60, 134],
] as const) {
	test(`CompositeBar moves non-fitting label tabs into its overflow menu (${overflowActionSize}px action)`, () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using disposables = new DisposableStore();
		const registry = new WorkbenchViewRegistry();
		const panels = [
			['ash.panel.problems', 'Problems'],
			['ash.panel.output', 'Output'],
			['ash.panel.terminal', 'Terminal'],
		] as const;
		for (const [id, title] of panels) {
			disposables.add(registry.registerViewContainer({ id, title, location: ViewContainerLocation.Panel }));
		}
		const contextKeys = disposables.add(new ContextKeyService());
		const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
		const selections: string[] = [];
		let overflowActions: readonly IAction[] = [];
		let hideOverflowMenu: (() => void) | undefined;
		const contextMenuProvider: IContextMenuProvider = {
			showContextMenu(options): void {
				overflowActions = options.getActions();
				hideOverflowMenu = () => options.onHide?.(true);
			},
		};
		const barOptions = {
			openComposite: async (id: string) => {
				selections.push(id);
				return null;
			},
			activityHoverOptions: { position: () => HoverPosition.ABOVE },
			viewDescriptorService: viewDescriptors,
			location: ViewContainerLocation.Panel,
			ariaLabel: 'Panel views',
			presentation: 'label' as const,
			overflowActionSize,
			contextMenuProvider,
		};
		const compositeBar = disposables.add(
			new CompositeBar(
				dom.window.document.body,
				barOptions,
				disposables.add(new ActivityService(viewDescriptors)),
			),
		);
		dom.window.document.body.append(compositeBar.domNode);
		Object.defineProperty(compositeBar.domNode, 'clientWidth', { configurable: true, value: availableWidth });
		compositeBar.setActiveComposite('ash.panel.terminal');
		const tabs = [...compositeBar.domNode.querySelectorAll<HTMLElement>('.ash-composite-bar-destination')];
		for (const tab of tabs) {
			tab.getBoundingClientRect = () => {
				const index = [...compositeBar.domNode.querySelectorAll('.ash-composite-bar-destination')].indexOf(tab);
				return { left: index * 50, right: (index + 1) * 50, width: 50 } as DOMRect;
			};
		}
		compositeBar.layout();

		assert.deepEqual(
			[...compositeBar.domNode.querySelectorAll("[role='tab']")].map(tab => tab.textContent),
			['Terminal', 'Additional views'],
		);
		const overflowItem = compositeBar.domNode.querySelector<HTMLElement>('.ash-composite-bar-overflow');
		assert.ok(overflowItem);
		assert.equal(overflowItem.getAttribute('role'), 'tab');
		assert.equal(compositeBar.domNode.querySelector('.ash-composite-bar-item')?.nextElementSibling, overflowItem);
		overflowItem.click();
		assert.equal(overflowItem.getAttribute('aria-expanded'), 'true');
		assert.deepEqual(
			overflowActions.map(action => action.label),
			['Problems', 'Output'],
		);
		const problems = overflowActions[0];
		assert.ok(problems);
		problems.run();
		assert.deepEqual(selections, ['ash.panel.problems']);
		assert.ok(hideOverflowMenu);
		hideOverflowMenu();
		assert.equal(overflowItem.getAttribute('aria-expanded'), 'false');
		assert.equal(overflowItem.isConnected, true);
		const retainedTerminal = tabs.find(tab => tab.dataset.actionId === 'ash.panel.terminal')!;
		compositeBar.setActiveComposite('ash.panel.terminal');
		compositeBar.layout();
		assert.equal(compositeBar.domNode.querySelector('[data-action-id="ash.panel.terminal"]'), retainedTerminal);
		assert.equal(compositeBar.domNode.querySelector('.ash-composite-bar-overflow'), overflowItem);
		assert.equal(retainedTerminal.getAttribute('aria-selected'), 'true');
		compositeBar.setActiveComposite('ash.panel.problems');
		assert.equal(
			compositeBar.domNode.querySelector('[data-action-id="ash.panel.problems"]')?.getAttribute('aria-selected'),
			'true',
		);
		compositeBar.domNode.querySelector<HTMLElement>('.ash-composite-bar-overflow')!.click();
		assert.deepEqual(
			overflowActions.map(action => action.label),
			['Output', 'Terminal'],
		);

		disposables.dispose();
		dom.window.close();
	});
}

for (const activeId of ['search', 'explorer']) {
	test(`Activity Bar unpinning active ${activeId} opens the default or first pinned view`, async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using disposables = new DisposableStore();
			const registry = new WorkbenchViewRegistry();
			for (const id of ['search', 'explorer', 'git']) {
				disposables.add(
					registry.registerViewContainer({
						id,
						title: id,
						location: ViewContainerLocation.Sidebar,
						isDefault: id === 'explorer',
					}),
				);
			}
			const contextKeys = disposables.add(new ContextKeyService());
			const views = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
			const opened: { id: string; preserveFocus: boolean | undefined }[] = [];
			let actions: readonly IAction[] = [];
			const bar = disposables.add(
				new CompositeBar(
					dom.window.document.body,
					{
						overflowActionSize: 22,
						openComposite: async (id, preserveFocus) => {
							opened.push({ id, preserveFocus });
							bar.setActiveComposite(id);
							return null;
						},
						activityHoverOptions: { position: () => HoverPosition.RIGHT },
						viewDescriptorService: views,
						location: ViewContainerLocation.Sidebar,
						ariaLabel: 'Views',
						orientation: 'vertical',
						contextMenuProvider: {
							showContextMenu(options) {
								actions = options.getActions();
							},
						},
					},
					disposables.add(new ActivityService(views)),
				),
			);
			bar.setActiveComposite(activeId);
			bar.showContextMenu(new dom.window.MouseEvent('contextmenu'));
			await actions.find(action => action.label === 'git')!.run();
			assert.deepEqual(opened, []);
			bar.showContextMenu(new dom.window.MouseEvent('contextmenu'));
			await actions.find(action => action.label === activeId)!.run();
			const nextId = activeId === 'search' ? 'explorer' : 'search';
			assert.deepEqual(opened, [{ id: nextId, preserveFocus: nextId === 'explorer' }]);
			assert.equal(bar.activeCompositeId, nextId);
			assert.equal(bar.domNode.querySelector(`[data-action-id="${activeId}"]`), null);
			assert.equal(
				bar.domNode.querySelector(`[data-action-id="${nextId}"]`)?.getAttribute('aria-selected'),
				'true',
			);
			bar.showContextMenu(new dom.window.MouseEvent('contextmenu'));
			assert.deepEqual(
				actions.map(action => [action.label, action.checked, action.enabled]),
				[
					['search', nextId === 'search', nextId !== 'search'],
					['explorer', nextId === 'explorer', nextId !== 'explorer'],
					['git', false, true],
				],
			);
			await actions.find(action => action.label === activeId)!.run();
			assert.equal(opened.length, 1);
			assert.equal(bar.activeCompositeId, nextId);
		} finally {
			dom.window.close();
		}
	});
}

test('Activity Bar context menu persists hidden views and keeps one pinned view', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	for (const [id, title] of [
		['ash.explorer', 'Explorer'],
		['ash.search', 'Search'],
	] as const) {
		disposables.add(registry.registerViewContainer({ id, title, location: ViewContainerLocation.Sidebar }));
	}
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'test',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const firstBar = new DisposableStore();
	let actions: readonly IAction[] = [];
	const contextMenuProvider: IContextMenuProvider = {
		showContextMenu(options) {
			actions = options.getActions();
		},
	};
	const compositeBar = firstBar.add(
		new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: viewDescriptors,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Primary side bar views',
				orientation: 'vertical',
				contextMenuProvider,
				storageService: storage,
			},
			disposables.add(new ActivityService(viewDescriptors)),
		),
	);
	const configuration = firstBar.add(new InMemoryConfigurationService());
	const globalBar = {
		domNode: dom.window.document.createElement('div'),
		setOrientation() {},
		getContextMenuActions: () => [],
	};
	const localization = {
		translate: (_bundle: string, _key: string, fallback: string) => fallback,
	} as ILocalizationService;
	const activitybar = firstBar.add(
		createTestActivitybar(dom.window.document.body, compositeBar, globalBar, configuration, localization),
	);
	activitybar.domNode.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
	assert.deepEqual(
		actions.slice(0, 2).map(action => [action.label, action.checked]),
		[
			['Explorer', true],
			['Search', true],
		],
	);
	assert.ok(actions.some(action => action.id === 'submenu.ActivityBarPositionMenu'));
	const search = activitybar.domNode.querySelector<HTMLElement>('[data-action-id="ash.search"]');
	assert.ok(search);
	search.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
	assert.equal(actions[0]?.label, 'Configure Keybinding');
	assert.equal(actions[1]?.label, "Hide 'Search'");
	await actions[1]?.run();
	assert.equal(activitybar.domNode.querySelector('[data-action-id="ash.search"]'), null);
	activitybar.domNode
		.querySelector<HTMLElement>('[data-action-id="ash.explorer"]')
		?.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
	assert.equal(actions.find(action => action.id === 'ash.activityBar.togglePinned.ash.explorer')?.enabled, false);
	assert.equal(actions.find(action => action.id === 'ash.activityBar.togglePinned.ash.search')?.checked, false);
	await storage.flush(WillSaveStateReason.SHUTDOWN);
	firstBar.dispose();
	storage.dispose();

	const restoredStorage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		workspaceId: 'other',
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const restored = new CompositeBar(
		dom.window.document.body,
		{
			overflowActionSize: 22,
			openComposite: async () => null,
			activityHoverOptions: { position: () => HoverPosition.ABOVE },
			viewDescriptorService: viewDescriptors,
			location: ViewContainerLocation.Sidebar,
			ariaLabel: 'Primary side bar views',
			orientation: 'vertical',
			contextMenuProvider,
			storageService: restoredStorage,
		},
		disposables.add(new ActivityService(viewDescriptors)),
	);
	assert.equal(restored.domNode.querySelector('[data-action-id="ash.search"]'), null);
	restored.dispose();
	restoredStorage.dispose();
	dom.window.close();
});

test('CompositeBar retains the startup language of View Container labels', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.panel.terminal.localized',
			title: 'Terminal',
			localizationKey: { bundle: 'ash.views', key: 'terminal' },
			location: ViewContainerLocation.Panel,
		}),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const localeChanges = new Emitter<string>();
	let locale = 'en';
	const localization = {
		translate: (_bundle: string, key: string, fallback: string) =>
			key === 'terminal' && locale === 'zh-CN' ? '终端' : fallback,
	} as unknown as ILocalizationService;
	const compositeBar = disposables.add(
		new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: viewDescriptors,
				localizationService: localization,
				location: ViewContainerLocation.Panel,
				ariaLabel: 'Panel views',
			},
			disposables.add(new ActivityService(viewDescriptors)),
		),
	);

	assert.equal(compositeBar.domNode.querySelector("[role='tab']")?.textContent, 'Terminal');
	locale = 'zh-CN';
	localeChanges.fire(locale);
	assert.equal(compositeBar.domNode.querySelector("[role='tab']")?.textContent, 'Terminal');

	localeChanges.dispose();
	disposables.dispose();
	dom.window.close();
});

test('Auxiliary Bar retains its View and exposes container selection as a standard Pane Composite', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.chat',
			title: 'Chat',
			location: ViewContainerLocation.AuxiliaryBar,
			isDefault: true,
		}),
	);
	disposables.add(
		registry.registerViews('ash.chat', [
			{ id: 'ash.chat.test', title: 'Chat', ctorDescriptor: new SyncDescriptor(TestPanelView) },
		]),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.AuxiliaryBar);
	assert.ok(descriptor);
	const composite = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{
			viewContainer: descriptor,
			model: viewDescriptors.getViewContainerModel(descriptor.id),
			paneHeaders: 'hidden',
			paneLayout: 'fill',
		},
	);
	const auxiliaryServices = disposables.add(registerContainerServices(componentServices).createChild());
	auxiliaryServices.registerInstance(IViewDescriptorService, viewDescriptors);
	auxiliaryServices.registerInstance(IContextKeyService, contextKeys);
	auxiliaryServices.registerInstance(PanelLocalizationService, {
		whenReady: Promise.resolve(),
		translate: (_bundle, _key, fallback) => fallback,
	});
	const commands = disposables.add(new CommandService(auxiliaryServices));
	auxiliaryServices.registerInstance(IMenuService, new MenuService(commands, contextKeys));
	auxiliaryServices.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		showContextMenu() {},
		hideContextMenu() {},
		onDidShowContextMenu: BaseEvent.None,
		onDidHideContextMenu: BaseEvent.None,
	});
	const contextViews = disposables.add(new BrowserContextViewService(dom.window.document.body));
	auxiliaryServices.registerInstance(
		IHoverService,
		disposables.add(
			new HoverService(
				auxiliaryServices.get(IConfigurationService),
				contextViews,
				auxiliaryServices.get(IContextMenuService),
			),
		),
	);
	const auxiliarybar = disposables.add(auxiliaryServices.createInstance(AuxiliaryBarPart, dom.window.document.body));
	auxiliarybar.addComposite(composite);
	auxiliarybar.showComposite(descriptor.id);
	const content = auxiliarybar.domNode.querySelector(':scope > .ash-auxiliarybar-content');

	assert.ok(content);
	assert.equal(content.firstElementChild, composite.element);
	assert.equal(auxiliarybar.activeCompositeId, descriptor.id);
	assert.equal(contextKeys.getValue('activeAuxiliary'), descriptor.id);
	const compositeBar = auxiliarybar.domNode.querySelector<HTMLElement>('.ash-composite-bar');
	assert.ok(compositeBar);
	assert.equal(compositeBar.hidden, false);
	const action = auxiliarybar.domNode.querySelector<HTMLButtonElement>(
		'.ash-pane-composite-title-view-actions button',
	);
	assert.ok(action);
	action.focus();
	auxiliarybar.showComposite(descriptor.id);
	assert.equal(dom.window.document.activeElement, action);

	disposables.dispose();
	dom.window.close();
});

class TestPanelView extends ViewPane {
	private readonly actions: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.actions = h(container.ownerDocument, 'div');
		this.actions.setAttribute('role', 'toolbar');
		this.actions.setAttribute('aria-label', 'Test panel actions');
		const button = h(container.ownerDocument, 'button');
		button.textContent = 'Run';
		this.actions.append(button);
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.actions };
	}
}

class ContentProjectionView extends ViewPane {
	private readonly titleContent: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.titleContent = h(container.ownerDocument, 'div');
		this.titleContent.dataset.projectionOwner = 'content';
	}

	override get partTitleProjection(): PartTitleProjection {
		return { content: this.titleContent };
	}
}

class ActionsProjectionView extends ViewPane {
	private readonly titleActions: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.titleActions = h(container.ownerDocument, 'div');
		this.titleActions.dataset.projectionOwner = 'actions';
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions };
	}
}

test('PaneComposite rejects ambiguous title projections from multiple Views', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(
		registry.registerViewContainer({
			id: 'ash.test.projection',
			title: 'Projection test',
			location: ViewContainerLocation.Panel,
			isDefault: true,
		}),
	);
	disposables.add(
		registry.registerViews('ash.test.projection', [
			{ id: 'ash.test.content', title: 'Content', ctorDescriptor: new SyncDescriptor(ContentProjectionView) },
			{ id: 'ash.test.actions', title: 'Actions', ctorDescriptor: new SyncDescriptor(ActionsProjectionView) },
		]),
	);
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.Panel);
	assert.ok(descriptor);
	const composite = registerContainerServices(componentServices).createInstance(
		PaneComposite,
		dom.window.document.body,
		{ viewContainer: descriptor, model: viewDescriptors.getViewContainerModel(descriptor.id) },
	);

	assert.throws(() => composite.partTitleProjection, /only one visible View/);

	composite.dispose();
	disposables.dispose();
	dom.window.close();
});

test('CompositeBar reorders view container tabs through drag and drop', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	for (const [id, title, order] of [
		['ash.panel.problems', 'Problems', 10],
		['ash.panel.output', 'Output', 20],
		['ash.panel.terminal', 'Terminal', 30],
	] as const) {
		disposables.add(registry.registerViewContainer({ id, title, order, location: ViewContainerLocation.Panel }));
	}
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contextKeys));
	const compositeBar = disposables.add(
		new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: viewDescriptors,
				location: ViewContainerLocation.Panel,
				ariaLabel: 'Panel views',
				presentation: 'label',
			},
			disposables.add(new ActivityService(viewDescriptors)),
		),
	);
	dom.window.document.body.append(compositeBar.domNode);
	const [problems, output] = compositeBar.domNode.querySelectorAll<HTMLElement>('.ash-composite-bar-destination');
	assert.ok(problems);
	assert.ok(output);
	output.getBoundingClientRect = () => ({ left: 100, width: 100 }) as DOMRect;

	problems.dispatchEvent(compositeBarDragEvent(dom.window, 'dragstart'));
	output.dispatchEvent(compositeBarDragEvent(dom.window, 'dragover', 175));
	output.dispatchEvent(compositeBarDragEvent(dom.window, 'drop', 175));
	assert.equal(compositeBar.domNode.querySelector('[data-action-id="ash.panel.problems"]'), problems);
	assert.equal(compositeBar.domNode.querySelector('[data-action-id="ash.panel.output"]'), output);

	assert.deepEqual(
		[...compositeBar.domNode.querySelectorAll<HTMLElement>("[role='tab']")].map(tab => tab.textContent),
		['Output', 'Problems', 'Terminal'],
	);
	disposables.dispose();
	dom.window.close();
});

test('titlebar layout commands toggle shell regions', async () => {
	const { IPaneCompositePartService } =
		await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, { defaultLayout: { parts: { panel: true } } });
	const services = new InstantiationService();
	services.registerInstance(IWorkbenchLayoutService, harness.layout);
	const openedPanels: unknown[][] = [];
	services.registerInstance(IPaneCompositePartService, {
		getProgressIndicator: () => undefined,
		onDidPaneCompositeOpen: BaseEvent.None,
		onDidPaneCompositeClose: BaseEvent.None,
		getLastActivePaneCompositeId: () => 'test.retained.panel',
		openPaneComposite: async (id, location, focus) => {
			openedPanels.push([id, location, focus]);
			return undefined;
		},
		getActivePaneComposite: () => undefined,
		getPartId: () => 'panel',
		hideActivePaneComposite() {},
	});
	const commands = harness.disposables.add(new CommandService(services));

	assert.equal(harness.layout.isPartVisible('sidebar'), true);
	await commands.executeCommand(ToggleSideBarCommandId);
	assert.equal(harness.layout.isPartVisible('sidebar'), false);
	await commands.executeCommand(ToggleSideBarCommandId);
	assert.equal(harness.layout.isPartVisible('sidebar'), true);

	assert.equal(harness.layout.isPartVisible('auxiliarybar'), true);
	await commands.executeCommand(ToggleAuxiliaryBarAction.ID);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), false);
	await commands.executeCommand(ToggleAuxiliaryBarAction.ID);
	assert.equal(harness.layout.isPartVisible('auxiliarybar'), true);

	assert.equal(harness.layout.isPartVisible('panel'), true);
	await commands.executeCommand(TogglePanelAction.ID);
	assert.equal(harness.layout.isPartVisible('panel'), false);
	await commands.executeCommand(TogglePanelAction.ID);
	assert.equal(harness.layout.isPartVisible('panel'), true);
	assert.deepEqual(openedPanels, [['test.retained.panel', ViewContainerLocation.Panel, true]]);

	assert.equal(harness.layout.isPartVisible('editor'), true);
	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	assert.equal(harness.layout.isPartVisible('panel'), true);
	assert.equal(harness.layout.isPartVisible('editor'), false);
	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	assert.equal(harness.layout.isPartVisible('editor'), true);

	await commands.executeCommand('workbench.action.toggleMaximizedPanel');
	await commands.executeCommand(TogglePanelAction.ID);
	assert.equal(harness.layout.isPartVisible('panel'), false);
	assert.equal(harness.layout.isPartVisible('editor'), true);

	harness.disposables.dispose();
	dom.window.close();
});

test('panel layout actions use state icons', () => {
	using disposables = new DisposableStore();
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(new InstantiationService()));
	const menuService = new MenuService(commands, contextKeys);
	const panelAction = () =>
		menuService
			.getMenuActions(MenuId.TitleBar)
			.flatMap(([, actions]) => actions)
			.find(action => action.id === TogglePanelAction.ID);
	const sidebarAction = () =>
		menuService
			.getMenuActions(MenuId.TitleBarLeft)
			.flatMap(([, actions]) => actions)
			.find(action => action.id === ToggleSideBarCommandId);
	const maximizePanelAction = () =>
		menuService
			.getMenuActions(MenuId.PanelTitle)
			.flatMap(([, actions]) => actions)
			.find(action => action.id === 'workbench.action.toggleMaximizedPanel');

	assert.equal(sidebarAction()?.icon, Lxicon.layoutSidebarLeftOff1);
	assert.equal(panelAction()?.icon, Lxicon.layoutPanelOff1);
	assert.ok(
		menuService
			.getMenuActions(MenuId.PanelTitle)
			.flatMap(([, actions]) => actions)
			.some(action => action.id === 'workbench.action.closePanel'),
	);
	contextKeys.setContext('sideBarVisible', true);
	assert.equal(sidebarAction()?.icon, Lxicon.layoutSidebarLeft1);
	contextKeys.setContext('panelVisible', true);
	assert.equal(panelAction()?.icon, Lxicon.layoutPanel1);
	assert.equal(maximizePanelAction()?.icon, Lxicon.screenFull);
	assert.equal(maximizePanelAction()?.checked, false);
	contextKeys.setContext('panelMaximized', true);
	assert.equal(maximizePanelAction()?.icon, Lxicon.screenNormal);
	assert.equal(maximizePanelAction()?.checked, true);
});

function dragWorkbenchSash(
	targetWindow: typeof browserEnvironment.window,
	container: HTMLElement,
	partId: WorkbenchPartId,
	boundaryIndex: number,
	delta: number,
): void {
	const part = container.querySelector<HTMLElement>(`[data-part='${partId}']`);
	assert.ok(part);
	const splitView = part.parentElement?.parentElement?.parentElement;
	if (!splitView?.classList.contains('ash-split-view')) {
		throw new Error(`Workbench Part ${partId} is not hosted by a SplitView`);
	}
	const sashes = [...splitView.querySelectorAll<HTMLElement>(':scope > .ash-sash')];
	const sash = sashes[boundaryIndex];
	assert.ok(sash);
	const vertical = sash.classList.contains('ash-sash-vertical');
	const event = (type: string, coordinate: number) =>
		new targetWindow.MouseEvent(type, {
			bubbles: true,
			button: 0,
			clientX: vertical ? coordinate : 0,
			clientY: vertical ? 0 : coordinate,
		});
	sash.dispatchEvent(event('pointerdown', 0));
	targetWindow.dispatchEvent(event('pointermove', delta));
	targetWindow.dispatchEvent(event('pointerup', delta));
}

function resetWorkbenchSash(
	targetWindow: typeof browserEnvironment.window,
	container: HTMLElement,
	partId: WorkbenchPartId,
	boundaryIndex: number,
): void {
	const part = container.querySelector<HTMLElement>(`[data-part='${partId}']`);
	assert.ok(part);
	const splitView = part.parentElement?.parentElement?.parentElement;
	if (!splitView?.classList.contains('ash-split-view')) {
		throw new Error(`Workbench Part ${partId} is not hosted by a SplitView`);
	}
	const sash = splitView.querySelectorAll<HTMLElement>(':scope > .ash-sash')[boundaryIndex];
	assert.ok(sash);
	sash.dispatchEvent(new targetWindow.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
}

function compositeBarDragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, 'clientX', { value: clientX });
	return event;
}

test('Activity Bar restores user container order in a new window and keeps the active container', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	for (const id of ['first', 'second', 'third']) {
		disposables.add(registry.registerViewContainer({ id, title: id, location: ViewContainerLocation.Sidebar }));
	}
	const storageOptions = { ownerWindow: dom.window as unknown as Window, workspaceId: 'first', flushInterval: 0 };
	const storage = disposables.add(new BrowserStorageService(storageOptions));
	const contexts = disposables.add(new ContextKeyService());
	const descriptors = disposables.add(new TestViewDescriptorService({ registry }, contexts));
	const bar = disposables.add(
		new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: descriptors,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Views',
				orientation: 'vertical',
				storageService: storage,
			},
			disposables.add(new ActivityService(descriptors)),
		),
	);
	bar.setActiveComposite('second');
	descriptors.moveViewContainer(ViewContainerLocation.Sidebar, 'third', 'first', 'before');
	assert.equal(bar.activeCompositeId, 'second');
	await storage.flush();
	const restoredStorage = disposables.add(new BrowserStorageService({ ...storageOptions, workspaceId: 'second' }));
	const restoredDescriptors = disposables.add(new TestViewDescriptorService({ registry }, contexts));
	const restored = disposables.add(
		new CompositeBar(
			dom.window.document.body,
			{
				overflowActionSize: 22,
				openComposite: async () => null,
				activityHoverOptions: { position: () => HoverPosition.ABOVE },
				viewDescriptorService: restoredDescriptors,
				location: ViewContainerLocation.Sidebar,
				ariaLabel: 'Views',
				orientation: 'vertical',
				storageService: restoredStorage,
			},
			disposables.add(new ActivityService(restoredDescriptors)),
		),
	);
	assert.deepEqual(
		[...restored.domNode.querySelectorAll<HTMLElement>('.ash-composite-bar-destination')].map(
			item => item.dataset.actionId,
		),
		['third', 'first', 'second'],
	);
	disposables.dispose();
	dom.window.close();
});

class TestRuntimeView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.contentElement.textContent = options.title;
	}
}

test('Pane composite service reveals retained Parts and publishes visibility changes once', async () => {
	const { PaneCompositePartService } = await import('../../../workbench/browser/parts/paneCompositePartService.js');
	const { IPaneCompositePartService } =
		await import('../../../workbench/services/panecomposite/browser/panecomposite.js');
	const { IViewDescriptorService } = await import('../../../workbench/common/views.js');
	const { IContextKeyService } = await import('../../../platform/contextkey/browser/contextKeyService.js');
	const { ILocalizationService } =
		await import('../../../workbench/services/localization/common/localizationService.js');
	const { IViewsService } = await import('../../../workbench/services/views/common/viewsService.js');
	const { ViewsService } = await import('../../../workbench/services/views/browser/viewsService.js');
	using resources = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	registry.registerStaticViewContainer({
		id: 'test.panel.first',
		title: 'First',
		location: ViewContainerLocation.Panel,
	});
	registry.registerStaticViewContainer({
		id: 'test.panel.second',
		title: 'Second',
		location: ViewContainerLocation.Panel,
	});
	registry.registerStaticViewContainer({
		id: 'test.panel.transient',
		title: 'Transient',
		location: ViewContainerLocation.Panel,
		hideIfEmpty: true,
	});
	registry.registerStaticViews('test.panel.transient', [
		{
			id: 'test.transient.view',
			title: 'Transient',
			when: ContextKeyExpr.has('test.transient.enabled'),
			ctorDescriptor: new SyncDescriptor(TestRuntimeView),
		},
	]);
	registry.registerStaticViews('test.panel.first', [
		{
			id: 'test.panel.view',
			title: 'View',
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(TestRuntimeView),
		},
		{
			id: 'test.panel.hidden',
			title: 'Hidden',
			hideByDefault: true,
			canToggleVisibility: true,
			ctorDescriptor: new SyncDescriptor(TestRuntimeView),
		},
	]);
	registry.registerStaticViews('test.panel.second', [
		{
			id: 'test.panel.conditional',
			title: 'Conditional',
			when: ContextKeyExpr.has('test.enabled'),
			ctorDescriptor: new SyncDescriptor(TestRuntimeView),
		},
	]);
	const context = resources.add(new ContextKeyService());
	const descriptors = resources.add(new TestViewDescriptorService({ registry }, context));
	const services = resources.add(new InstantiationService());
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IViewDescriptorService, descriptors);
	services.registerInstance(IStorageService, paneStorage);
	services.registerInstance(ILocalizationService, {
		whenReady: Promise.resolve(),
		translate: (_bundle, _key, source) => source,
	});
	const commands = resources.add(new CommandService(services));
	services.registerInstance(IMenuService, new MenuService(commands, context));
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		showContextMenu() {},
		hideContextMenu() {},
		onDidShowContextMenu: BaseEvent.None,
		onDidHideContextMenu: BaseEvent.None,
	});
	const panel = resources.add(
		registerContainerServices(services).createInstance(PanelPart, browserEnvironment.window.document.body),
	);
	panel.setVisible(false);
	services.registerInstance(IWorkbenchLayoutService, {
		isPartVisible: () => !panel.domNode.hidden,
		showPart: () => panel.setVisible(true),
		hidePart: () => panel.setVisible(false),
	} as unknown as import('../../../workbench/services/layout/browser/layoutService.js').IWorkbenchLayoutService);
	const parts = new Map([[ViewContainerLocation.Panel, panel]]);
	const panes = resources.add(services.createInstance(PaneCompositePartService, parts));
	services.registerInstance(IPaneCompositePartService, panes);
	const runtimeViews = resources.add(services.createInstance(ViewsService));
	services.registerInstance(IViewsService, runtimeViews);
	const events: string[] = [];
	resources.add(panes.onDidPaneCompositeOpen(event => events.push(`open:${event.composite.id}`)));
	resources.add(panes.onDidPaneCompositeClose(event => events.push(`close:${event.composite.id}`)));
	assert.equal(await panes.openPaneComposite('test.panel.transient', ViewContainerLocation.Panel), undefined);
	const first = await panes.openPaneComposite('test.panel.first', ViewContainerLocation.Panel);
	await panes.openPaneComposite('test.panel.first', ViewContainerLocation.Panel);
	await panes.openPaneComposite('test.panel.second', ViewContainerLocation.Panel);
	panes.hideActivePaneComposite(ViewContainerLocation.Panel);
	assert.deepEqual(
		{
			active: panes.getActivePaneComposite(ViewContainerLocation.Panel),
			last: panes.getLastActivePaneCompositeId(ViewContainerLocation.Panel),
		},
		{ active: undefined, last: 'test.panel.second' },
	);
	assert.equal(await panes.openPaneComposite('test.panel.first', ViewContainerLocation.Panel), first);
	assert.deepEqual(
		{
			events,
			active: panes.getActivePaneComposite(ViewContainerLocation.Panel)?.id,
			visible: !panel.domNode.hidden,
		},
		{
			events: [
				'open:test.panel.first',
				'close:test.panel.first',
				'open:test.panel.second',
				'close:test.panel.second',
				'open:test.panel.first',
			],
			active: 'test.panel.first',
			visible: true,
		},
	);
	const views = services.get(IViewsService);
	const runtimeEvents: string[] = [];
	resources.add(
		views.onDidChangeViewContainerVisibility(event => runtimeEvents.push(`container:${event.id}:${event.visible}`)),
	);
	resources.add(views.onDidChangeViewVisibility(event => runtimeEvents.push(`view:${event.id}:${event.visible}`)));
	resources.add(views.onDidChangeFocusedView(() => runtimeEvents.push(`focus:${views.getFocusedView()?.id ?? ''}`)));
	assert.equal(await views.openView('test.panel.view'), first!.getView('test.panel.view'));
	assert.equal(await views.focusView('test.panel.view'), true);
	assert.equal(views.getFocusedViewName(), 'View');
	assert.equal(context.getValue('focusedView'), 'test.panel.view');
	// Focus tracking waits for focus to leave the pane before accepting the next command's focus.
	const commandFocus = new Promise<void>(resolve =>
		resources.add(first!.getView('test.panel.view')!.onDidBlur(resolve)),
	);
	const commandInput = h(browserEnvironment.window.document, 'input');
	browserEnvironment.window.document.body.append(commandInput);
	resources.add(toDisposable(() => commandInput.remove()));
	commandInput.focus();
	await commandFocus;
	await commands.executeCommand('workbench.action.closePanel');
	await commands.executeCommand('workbench.action.closePanel');
	assert.equal(panel.domNode.hidden, true);
	await commands.executeCommand('workbench.action.focusPanel');
	assert.deepEqual(
		{
			visible: !panel.domNode.hidden,
			retained: panes.getActivePaneComposite(ViewContainerLocation.Panel),
			focused: views.getFocusedView()?.id,
		},
		{ visible: true, retained: first, focused: 'test.panel.view' },
	);
	assert.equal(await views.openView('test.panel.conditional', true), null);
	assert.equal(views.getVisibleViewContainer(ViewContainerLocation.Panel)?.id, 'test.panel.first');
	const oldViewBlurred = new Promise<void>(resolve => {
		resources.add(first!.getView('test.panel.view')!.onDidBlur(resolve));
	});
	assert.equal(await views.openView('test.panel.hidden', true), first!.getView('test.panel.hidden'));
	await oldViewBlurred;
	assert.deepEqual(
		{ focused: views.getFocusedView()?.id, context: context.getValue('focusedView') },
		{ focused: 'test.panel.hidden', context: 'test.panel.hidden' },
	);
	assert.equal(views.isViewVisible('test.panel.hidden'), true);
	views.closeView('test.panel.hidden');
	assert.deepEqual(
		{
			visible: views.isViewVisible('test.panel.hidden'),
			container: views.isViewContainerVisible('test.panel.first'),
			expanded: first!.getView('test.panel.hidden')!.isExpanded(),
		},
		{ visible: false, container: true, expanded: false },
	);
	await views.openView('test.panel.hidden', true);
	views.closeViewContainer('test.panel.first');
	assert.deepEqual(
		{
			focused: views.getFocusedView(),
			context: context.getValue('focusedView'),
			active: views.getActiveViewWithId('test.panel.view'),
			retained: views.getViewWithId('test.panel.view'),
		},
		{ focused: null, context: '', active: null, retained: first!.getView('test.panel.view') },
	);
	const closedEvents = [...runtimeEvents];
	views.closeViewContainer('test.panel.first');
	assert.deepEqual(runtimeEvents, closedEvents);
	await views.openViewContainer('test.panel.second');
	views.closeViewContainer('test.panel.first');
	assert.equal(views.isViewContainerVisible('test.panel.second'), true);
	assert.equal(views.getActiveViewPaneContainerWithId('test.panel.first'), null);
	assert.equal(views.isViewContainerActive('test.panel.first'), true);
	await views.openView('test.panel.view', true);
	assert.equal(views.getViewWithId('test.panel.view'), first!.getView('test.panel.view'));
	assert.ok(runtimeEvents.includes('view:test.panel.hidden:false'));
	assert.ok(runtimeEvents.includes('focus:'));
	const dynamicRegistration = resources.add(
		registry.registerViewContainer({
			id: 'test.panel.dynamic',
			title: 'Dynamic',
			location: ViewContainerLocation.Panel,
		}),
	);
	resources.add(
		registry.registerViews('test.panel.dynamic', [
			{ id: 'test.dynamic.view', title: 'Dynamic view', ctorDescriptor: new SyncDescriptor(TestRuntimeView) },
		]),
	);
	await views.openView('test.dynamic.view', true);
	const dynamic = panel.getComposite('test.panel.dynamic')!;
	views.closeView('test.dynamic.view');
	assert.equal(views.isViewContainerVisible('test.panel.dynamic'), false);
	assert.equal(views.getFocusedView(), null);
	await views.openView('test.dynamic.view', true);
	dynamicRegistration.dispose();
	assert.deepEqual(
		{
			disposed: dynamic.isDisposed,
			retained: panel.getComposite('test.panel.dynamic'),
			view: views.getViewWithId('test.dynamic.view'),
			focused: views.getFocusedView(),
			active: views.isViewContainerActive('test.panel.dynamic'),
		},
		{ disposed: true, retained: undefined, view: null, focused: null, active: false },
	);
	assert.equal(await views.openView('missing'), null);
	assert.equal(await panes.openPaneComposite('missing', ViewContainerLocation.Panel), undefined);
	using incomplete = new InstantiationService();
	assert.throws(() => incomplete.createInstance(PaneCompositePartService, parts), /service/i);
	assert.throws(() => incomplete.createInstance(ViewDescriptorService, { registry }), /service/i);
	assert.throws(() => incomplete.createInstance(ViewsService), /service/i);
	await views.openView('test.panel.view', true);
	const beforeDisposal = [...runtimeEvents];
	runtimeViews.dispose();
	await panes.openPaneComposite('test.panel.second', ViewContainerLocation.Panel);
	assert.deepEqual(
		{ events: runtimeEvents, context: context.getValue('focusedView'), retained: first!.isDisposed },
		{ events: beforeDisposal, context: '', retained: false },
	);
});

function createTestActivitybar(
	container: HTMLElement,
	composites: InstanceType<typeof CompositeBar>,
	global: ConstructorParameters<typeof ActivitybarPart>[2],
	configuration: ConstructorParameters<typeof ActivitybarPart>[3],
	localization: ILocalizationService,
): InstanceType<typeof ActivitybarPart> {
	const services = createTestComponentServices(paneStorage);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(PanelLocalizationService, localization);
	const contexts = new ContextKeyService();
	services.registerInstance(IContextKeyService, contexts);
	services.registerInstance(IKeybindingService, {
		lookupKeybinding: () => undefined,
	} as unknown as import('../../../platform/keybinding/common/keybinding.js').IKeybindingService);
	const layoutContext = new LayoutActionsContext(configuration, contexts);
	const commands = new CommandService(services);
	services.registerInstance(IMenuService, new MenuService(commands, contexts));
	const part = registerContainerServices(services).createInstance(ActivitybarPart, container, composites, global);
	// This fixture container belongs to the created Part's test lifetime.
	suiteTeardown(() => {
		layoutContext.dispose();
		contexts.dispose();
		commands.dispose();
		services.dispose();
	});
	return part;
}

const titleMenuResources = new DisposableStore();
suiteTeardown(() => titleMenuResources.dispose());

function registerContainerServices(
	services: InstanceType<typeof InstantiationService>,
): InstanceType<typeof InstantiationService> {
	if (!services.has(IConfigurationService))
		services.registerInstance(IConfigurationService, titleMenuResources.add(new InMemoryConfigurationService()));
	if (!services.has(IContextKeyService))
		services.registerInstance(IContextKeyService, titleMenuResources.add(new ContextKeyService()));
	if (!services.has(IViewDescriptorService))
		services.registerInstance(
			IViewDescriptorService,
			titleMenuResources.add(services.createInstance(ViewDescriptorService, {})),
		);
	registerTestComponentServices(services);
	if (!services.has(IMenuService)) {
		const context = titleMenuResources.add(new ContextKeyService());
		const commands = titleMenuResources.add(new CommandService(services));
		services.registerInstance(IMenuService, new MenuService(commands, context));
	}
	return services;
}

test('auxiliary layout completes hosted geometry before container notifications and retains fractional bounds', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const popup = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		const harness = createLayoutHarness(dom.window.document);
		using resources = harness.disposables;
		Object.defineProperty(dom.window, 'open', { configurable: true, value: () => popup.window });
		const auxiliary = await harness.services.get(IAuxiliaryWindowService).open();
		const bounds = new popup.window.DOMRect(0, 0, 1_000.2, 700.8);
		auxiliary.container.getBoundingClientRect = () => bounds;
		Object.defineProperties(auxiliary.container, { clientWidth: { value: 1_000 }, clientHeight: { value: 701 } });
		const participant = h(popup.window.document, 'div');
		auxiliary.container.append(participant);
		const order: string[] = [];
		const completed: {
			dimension: { readonly width: number; readonly height: number };
			width: string;
			height: string;
		}[] = [];
		resources.add(
			harness.layout.onDidLayoutContainer(({ dimension }) => {
				order.push('container');
				completed.push({ dimension, width: participant.style.width, height: participant.style.height });
			}),
		);
		// Participants register after open(), when the container forwarding listener already exists.
		resources.add(
			auxiliary.onWillLayout(dimension => {
				order.push('participant');
				participant.style.width = `${dimension.width}px`;
				participant.style.height = `${dimension.height}px`;
			}),
		);
		resources.add(auxiliary.onDidLayout(() => order.push('complete')));
		popup.window.dispatchEvent(new popup.window.Event('resize'));
		assert.deepEqual(order, ['participant', 'container', 'complete']);
		assert.deepEqual(completed, [
			{ dimension: new Dimension(1_000.2, 700.8), width: '1000.2px', height: '700.8px' },
		]);
		auxiliary.dispose();
		popup.window.dispatchEvent(new popup.window.Event('resize'));
		assert.deepEqual(order, ['participant', 'container', 'complete']);
	} finally {
		popup.window.close();
		dom.window.close();
	}
});

test('auxiliary containers route Quick Input and context views through focus, resize and close', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	const popup = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		const harness = createLayoutHarness(dom.window.document);
		using resources = harness.disposables;
		Object.defineProperty(dom.window, 'open', { configurable: true, value: () => popup.window });
		const windows = harness.services.get(IAuxiliaryWindowService);
		const auxiliary = await windows.open();
		const root = auxiliary.container;
		assert.deepEqual([...harness.layout.containers], [harness.container, root]);
		assert.equal(harness.layout.getContainer(auxiliary.window), root);
		assert.equal(harness.layout.whenContainerStylesLoaded(auxiliary.window), auxiliary.whenStylesHaveLoaded);

		using contexts = new ContextKeyService();
		using quickInput = new TestQuickInputService({
			instantiationService: harness.services,
			container: harness.container,
			contextKeyService: contexts,
			layoutService: harness.layout,
		});
		using mainPicker = quickInput.createQuickPick();
		mainPicker.show();
		const target = h(popup.window.document, 'button');
		root.append(target);
		target.focus();
		assert.equal(harness.layout.activeContainer, root);
		assert.equal(quickInput.currentQuickInput, undefined);
		assert.equal(harness.container.querySelector('.ash-quick-pick'), null);

		using picker = quickInput.createQuickPick();
		picker.items = [{ label: 'Auxiliary choice' }];
		picker.show();
		assert.equal(quickInput.currentQuickInput, picker);
		assert.ok(root.querySelector('.ash-quick-pick input'));
		assert.equal(harness.container.querySelector('.ash-quick-pick'), null);
		picker.hide();
		assert.equal(popup.window.document.activeElement, target);

		const { BrowserContextViewService } =
			await import('../../../platform/contextview/browser/contextViewService.js');
		using contextViews = new BrowserContextViewService(harness.container, harness.layout);
		const content = h(popup.window.document, 'div');
		assert.equal(contextViews.show({ anchor: target, content }), true);
		assert.equal(content.closest('.ash-workbench') ?? content.parentElement?.parentElement, root);
		const layouts: import('../../../platform/layout/browser/layoutService.js').ILayoutContainerEvent[] = [];
		resources.add(harness.layout.onDidLayoutContainer(event => layouts.push(event)));
		Object.defineProperties(popup.window, {
			innerWidth: { configurable: true, value: 680 },
			innerHeight: { configurable: true, value: 490 },
		});
		auxiliary.layout();
		assert.deepEqual(
			layouts.map(event => [event.container, event.dimension.width, event.dimension.height]),
			[[root, 680, 490]],
		);

		picker.show();
		harness.container.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
		assert.equal(harness.layout.activeContainer, harness.container);
		assert.equal(quickInput.currentQuickInput, undefined);
		root.dispatchEvent(new popup.window.KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
		assert.equal(harness.layout.activeContainer, root);
		picker.show();
		auxiliary.dispose();
		assert.equal(harness.layout.activeContainer, harness.container);
		assert.deepEqual([...harness.layout.containers], [harness.container]);
		assert.throws(() => harness.layout.getContainer(auxiliary.window), /not registered/);
		assert.equal(root.querySelector('.ash-quick-input-host'), null);
		assert.equal(harness.container.querySelector('.ash-context-view')?.hasAttribute('hidden'), true);
		mainPicker.show();
		assert.equal(quickInput.currentQuickInput, mainPicker);
	} finally {
		popup.window.close();
		dom.window.close();
	}
});

test('Panel position commands rotate the actual Grid, retain focus and restore both axis sizes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash-panel-position.test' });
	const harness = createLayoutHarness(dom.window.document, {
		defaultLayout: { parts: { panel: true, sidebar: false, auxiliarybar: false } },
	});
	try {
		harness.layout.layout(new Dimension(1_200, 900));
		const panel = harness.container.querySelector<HTMLElement>("[data-part='panel']")!;
		const input = dom.window.document.createElement('input');
		panel.append(input);
		const commands = harness.disposables.add(new CommandService(harness.services));
		const context = harness.disposables.add(new ContextKeyService());
		harness.disposables.add(createTestWorkbenchContextKeysHandler(context, { layoutService: harness.layout }));
		const menus = new MenuService(commands, context);
		const events: string[] = [];
		harness.disposables.add(harness.layout.onDidChangePanelPosition(value => events.push(value)));
		for (const [position, suffix, direction] of [
			[Position.LEFT, 'Left', 'right'],
			[Position.RIGHT, 'Right', 'left'],
			[Position.TOP, 'Top', 'down'],
			[Position.BOTTOM, 'Bottom', 'up'],
		] as const) {
			input.focus();
			await commands.executeCommand(`workbench.action.positionPanel${suffix}`);
			assert.equal(harness.layout.getPanelPosition(), position);
			assert.equal(context.getValue('panelPosition'), suffix.toLowerCase());
			assert.equal(
				menus
					.getMenuActions(MenuId.for('PanelPositionMenu'))
					.flatMap(([, actions]) => actions)
					.find(action => action.checked)?.id,
				`workbench.action.positionPanel${suffix}`,
			);
			// jsdom has no bounding boxes. Inspect the real Grid's emitted pane
			// coordinates here; the Desktop scenario measures the rendered boxes.
			const panelPane = panel.parentElement!.parentElement!;
			const editorPane = harness.editor.domNode.parentElement!.parentElement!;
			assert.equal(panelPane.parentElement, editorPane.parentElement);
			const horizontal = direction === 'left' || direction === 'right';
			const axis = horizontal ? 'left' : 'top';
			const extent = horizontal ? 'width' : 'height';
			assert.equal(
				panelPane.parentElement!.classList.contains(`ash-split-view-${horizontal ? 'horizontal' : 'vertical'}`),
				true,
			);
			const [leading, trailing] =
				direction === 'right' || direction === 'down' ? [panelPane, editorPane] : [editorPane, panelPane];
			assert.equal(
				Number.parseFloat(leading!.style[axis]) + Number.parseFloat(leading!.style[extent]),
				Number.parseFloat(trailing!.style[axis]),
			);
			assert.equal(dom.window.document.activeElement, input);
			const size = harness.layout.getPartSize('panel');
			if (position === Position.LEFT || position === Position.RIGHT) assert.equal(size.width, 256);
			else assert.equal(size.height, 256);
			harness.layout.toggleMaximizedPanel();
			harness.layout.toggleMaximizedPanel();
			assert.deepEqual(harness.layout.getPartSize('panel'), size);
		}
		assert.deepEqual(events, ['left', 'right', 'top', 'bottom']);
		harness.layout.hidePart('panel');
		await commands.executeCommand('workbench.action.positionPanelBottom');
		assert.equal(harness.layout.isPartVisible('panel'), true);
		harness.layout.setPanelPosition(Position.LEFT);
		harness.layout.resizePart('panel', new Dimension(420, harness.layout.getPartSize('panel').height));
		harness.layout.setPanelPosition(Position.BOTTOM);
		harness.layout.resizePart('panel', new Dimension(harness.layout.getPartSize('panel').width, 230));
		harness.layout.setPanelPosition(Position.RIGHT);
		assert.equal(harness.layout.getPartSize('panel').width, 420);
		const state = harness.layout.state;
		assert.equal(state.panel.height, 230);
		assert.throws(
			() => harness.layout.restoreState({ ...state, panel: { ...state.panel, position: 99 } }),
			/invalid or unsupported/,
		);
		assert.throws(
			() => harness.layout.restoreState({ ...state, panel: { ...state.panel, width: Number.NaN } }),
			/invalid or unsupported/,
		);
		harness.layout.restoreState(state);
		const restored = createLayoutHarness(dom.window.document, {
			storageService: harness.services.get(IStorageService),
		});
		try {
			restored.layout.layout(new Dimension(1_200, 900));
			assert.equal(restored.layout.getPanelPosition(), Position.RIGHT);
			assert.equal(restored.layout.getPartSize('panel').width, 420);
			restored.layout.setPanelPosition(Position.TOP);
			assert.equal(restored.layout.getPartSize('panel').height, 230);
		} finally {
			restored.disposables.dispose();
		}
	} finally {
		harness.disposables.dispose();
		dom.window.close();
	}
});

test('Panel default setting applies to new workspaces while saved workspace position wins', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const first = createLayoutHarness(dom.window.document, {
		panelDefaultLocation: 'left',
		defaultLayout: { parts: { panel: true } },
	});
	try {
		assert.equal(first.layout.getPanelPosition(), Position.LEFT);
		await assert.rejects(
			first.configuration.updateValue(WorkbenchConfiguration.panelDefaultLocation, 'center'),
			/Panel location/,
		);
		first.layout.setPanelPosition(Position.RIGHT);
		const storage = first.services.get(IStorageService) as InstanceType<typeof BrowserStorageService>;
		const restored = createLayoutHarness(dom.window.document, {
			panelDefaultLocation: 'top',
			storageService: storage,
		});
		try {
			assert.equal(restored.layout.getPanelPosition(), Position.RIGHT);
			storage.switchWorkspace('new-panel-workspace');
			restored.layout.restoreWorkspaceState();
			assert.equal(restored.layout.getPanelPosition(), Position.TOP);
			await restored.configuration.updateValue(WorkbenchConfiguration.panelDefaultLocation, 'left');
			assert.equal(restored.layout.getPanelPosition(), Position.TOP);
			storage.switchWorkspace('another-panel-workspace');
			restored.layout.restoreWorkspaceState();
			assert.equal(restored.layout.getPanelPosition(), Position.LEFT);
		} finally {
			restored.disposables.dispose();
		}
	} finally {
		first.disposables.dispose();
		dom.window.close();
	}
});

test('Workbench banner occupies transient space and survives topology rebuilds', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const harness = createLayoutHarness(dom.window.document, { initialDimension: new Dimension(1_200, 800) });
	try {
		harness.layout.layout(new Dimension(1_200, 800));
		const before = harness.layout.getPartSize('editor').height;
		assert.equal(harness.layout.isPartVisible('banner'), false);
		harness.layout.showPart('banner');
		assert.equal(harness.layout.mainContainerOffset.top, 67);
		assert.equal(harness.layout.getPartSize('editor').height, before - 32);
		harness.layout.setSideBarLocation('right');
		assert.equal(harness.layout.isPartVisible('banner'), true);
		assert.equal(harness.layout.getPartSize('banner').height, 32);
		harness.layout.hidePart('banner');
		assert.equal(harness.layout.mainContainerOffset.top, 35);
		assert.equal(harness.layout.getPartSize('editor').height, before);
		assert.equal('banner' in harness.layout.state, false);
	} finally {
		harness.disposables.dispose();
		dom.window.close();
	}
});
