import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { h } from '../../../src/ash/base/browser/dom.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { AuxiliarybarPart } from '../../../src/ash/workbench/browser/parts/auxiliarybar/auxiliarybarPart.js';
import type { PartTitleProjection } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import { ChatViewTitleControl } from '../../../src/ash/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { CompositeBar } from '../../../src/ash/workbench/browser/parts/compositeBar.js';
import { HoverPosition } from '../../../src/ash/base/browser/ui/hover/hoverWidget.js';
import { ActivityService } from '../../../src/ash/workbench/services/activity/browser/activityService.js';
import { NumberBadge } from '../../../src/ash/workbench/services/activity/common/activity.js';
import { Pane, PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import '../../../src/ash/base/browser/ui/actionbar/actionbar.css';
import '../../../src/ash/base/browser/ui/grid/grid.css';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Keybinding, logicalKey, physicalKey, resolveKeybinding } from '../../../src/ash/base/common/keybindings.js';
import { CommandRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { ShowAllCommandsCommandId } from '../../../src/ash/workbench/browser/quickaccess.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope } from '../../../src/ash/platform/storage/common/storage.js';
import { PaneCompositePartService } from '../../../src/ash/workbench/browser/parts/paneCompositePartService.js';
import { PanelPart } from '../../../src/ash/workbench/browser/parts/panel/panelPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import type { IComposite } from '../../../src/ash/workbench/common/composite.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IWorkbenchLayoutService } from '../../../src/ash/workbench/services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IPaneCompositePartService } from '../../../src/ash/workbench/services/panecomposite/browser/panecomposite.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { ViewsService } from '../../../src/ash/workbench/services/views/browser/viewsService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { createTestEditorServices, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { EditorPaneRegistry } from '../../../src/ash/workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import { CODE_EDITOR_ID, TextResourceEditor, type EditorPaneOptions } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import type { IEditorPane } from '../../../src/ash/workbench/common/editor.js';
import { SessionGridLayout } from '../../../src/ash/sessions/browser/parts/sessions/sessionGridLayout.js';
import type { IView } from '../../../src/ash/base/browser/ui/grid/grid.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { AppServerFileSystemProvider } from '../../../src/ash/platform/agentHost/browser/appServerFileSystemProvider.js';
import { createDisconnectedFileApi } from '../../../src/ash/platform/files/browser/fileApi.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { FileEditorInput } from '../../../src/ash/workbench/contrib/files/browser/editors/fileEditorInput.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { WorkbenchConfiguration, type ModernUIEditorTabStyle } from '../../../src/ash/workbench/common/configuration.js';
import { EditorTabSizingConfiguration, type EditorTabSizing } from '../../../src/ash/workbench/services/editor/common/editorConfiguration.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

interface CompositeState {
	readonly id: string;
	readonly title: string | undefined;
	readonly focused: boolean;
	readonly retained: boolean;
}

declare global {
	interface Window {
		ashSessionGridIntegration: {
			show(ids: readonly string[], active: string): Promise<void>;
			replace(id: string): Promise<void>;
			active(): string;
		};
		ashCompositeIntegration: {
			setBadge(count: number): void;
			setBadgeOrientation(orientation: 'horizontal' | 'vertical'): void;
			setBadgeCompact(compact: boolean): void;
			toggleBadge(): void;
			readonly events: readonly string[];
			state(): readonly CompositeState[];
			open(id: string, focus?: boolean): Promise<void>;
			resize(width: number, height: number): void;
			geometry(): { hostWidth: number; hostHeight: number; paneWidth: number; paneHeight: number; };
			hide(): void;
			openView(id: string): Promise<void>;
			dispose(): void;
			flushPaneState(): Promise<number | undefined>;
			reattachDisposed(): void;
			readonly editorEvents: readonly string[];
			readonly partEvents: readonly { id: string; focus?: boolean; visible: boolean; }[];
			openEditor(name: string): Promise<void>;
			resizeEditor(width: number, height: number): void;
			setWatermarkBinding(command: string, key: string | null): void;
			readonly watermarkCommands: readonly string[];
			configureEditorTabs(style: ModernUIEditorTabStyle, sizing?: EditorTabSizing): Promise<void>;
			setEditorTheme(id: string): void;
			closeEditor(name: string): Promise<void>;
			openFileAliases(target?: 'modalGroup'): Promise<{ tabs: number; models: number; retained: boolean; text: string; }>;
			editorState(): readonly { name: string; focused: boolean; visible: boolean; retained: boolean; }[];
		};
	}
}

class FocusView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		for (const label of ['First input', 'Second input']) {
			const input = h(this.contentElement.ownerDocument, 'input');
			input.setAttribute('aria-label', label);
			this.contentElement.append(input);
		}
	}

	public override focus(): void {
		this.contentElement.querySelector<HTMLInputElement>('input')!.focus();
	}
}

const resources = new DisposableStore();
if (new URLSearchParams(location.search).has('editorTabs') || new URLSearchParams(location.search).has('badges') || new URLSearchParams(location.search).has('emptyEditor')) {
	await import('../../../src/ash/base/browser/ui/iconlabel/iconlabel.css');
}
if (new URLSearchParams(location.search).has('badges') || new URLSearchParams(location.search).has('emptyEditor')) {
	await import('../../../src/ash/workbench/browser/media/style.css');
}
if (new URLSearchParams(location.search).has('badges')) {
	await import('../../../src/ash/workbench/browser/parts/activitybar/media/activitybarpart.css');
}
const uriIdentityServices = resources.add(new TestUriIdentityServices());
const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const registry = new WorkbenchViewRegistry();
for (const id of ['first', 'second']) {
	resources.add(registry.registerViewContainer({ id, title: `${id} container`, icon: new URLSearchParams(location.search).has('badges') ? Lxicon.gitBranch : undefined, location: ViewContainerLocation.Panel }));
	resources.add(registry.registerViews(id, [{ id: `${id}.view`, title: `${id} view`, ctorDescriptor: new SyncDescriptor(FocusView) }]));
}
const services = resources.add(new InstantiationService());
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'composite', backend: window.localStorage, flushInterval: 0 }));
services.registerInstance(IStorageService, storage);
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, source) => source });
services.registerInstance(IViewDescriptorService, resources.add(services.createInstance(ViewDescriptorService, { registry })));
const commands = resources.add(new CommandService(services));
services.registerInstance(IMenuService, new MenuService(commands, contexts));
// Context menus and global layout are outside this content-focus scenario.
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom',
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() { },
});
const panel = resources.add(registerTestComponentServices(services).createInstance(PanelPart, document.body));
if (new URLSearchParams(location.search).has('paneTransitions')) {
	await import('../../../src/ash/base/browser/ui/sash/sash.css');
	const paneHost = h(document, 'div');
	paneHost.id = 'pane-transitions';
	paneHost.style.cssText = 'position:fixed;top:0;right:0;width:300px;height:600px';
	document.body.append(paneHost);
	resources.add(toDisposable(() => paneHost.remove()));
	resources.add(bindColorTheme(services.get(IThemeService), paneHost));
	const paneView = resources.add(new PaneView(paneHost));
	for (const title of ['Changes', 'Agent Review', 'Graph']) {
		const pane = resources.add(new Pane(paneHost, { id: `transition.${title}`, title, collapsed: title !== 'Changes' }));
		paneView.addPane(pane, title === 'Changes' ? 544 : 28);
	}
	paneView.layout(600, 300);
}
panel.domNode.style.cssText = 'position:relative;width:800px;height:160px;overflow:hidden';
panel.layout({ width: 800, height: 160 });
services.registerInstance(IWorkbenchLayoutService, {
	showPart: () => panel.setVisible(true),
	hidePart: () => panel.setVisible(false),
} as unknown as IWorkbenchLayoutService);
const panes = resources.add(services.createInstance(PaneCompositePartService, new Map([[ViewContainerLocation.Panel, panel]])));
services.registerInstance(IPaneCompositePartService, panes);
services.registerInstance(IViewsService, resources.add(services.createInstance(ViewsService)));
const views = services.get(IViewsService);
const composites = new Map<string, IComposite>();
const events: string[] = [];
for (const id of ['first', 'second']) {
	const composite = (await views.openViewContainer(id))!;
	composites.set(id, composite);
	resources.add(composite.onDidFocus(() => events.push(`${id}:focus`)));
	resources.add(composite.onDidBlur(() => events.push(`${id}:blur`)));
}
await views.openViewContainer('first');
const firstRoot = panel.getComposite('first')!.getControl().element;

const partEvents: { id: string; focus?: boolean; visible: boolean; }[] = [];
resources.add(panel.onDidCompositeOpen(({ composite, focus }) => partEvents.push({ id: composite.getId(), focus, visible: true })));
resources.add(panel.onDidCompositeClose(composite => partEvents.push({ id: composite.getId(), visible: false })));
const editorHost = h(document, 'div');
editorHost.id = 'editor-tabs-host';
if (new URLSearchParams(location.search).has('editorTabs')) editorHost.className = 'ash-workbench modern-ui';
editorHost.style.cssText = 'position:relative;display:flex;width:800px;height:260px';
document.body.append(editorHost);
resources.add(toDisposable(() => editorHost.remove()));
const resourceStore: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
	save: async () => ({ revision: undefined }),
};
const modelServices = resources.add(new InstantiationService());
modelServices.registerInstance(IUriIdentityService, uriIdentityServices.get(IUriIdentityService));
const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {}));
modelServices.registerInstance(IFileTextModelService, models);
modelServices.registerInstance(ITextModelResourceService, models);
const editorServices = resources.add(createTestEditorServices(undefined, modelServices));
resources.add(bindColorTheme(editorServices.get(IThemeService), document.documentElement));
if (new URLSearchParams(location.search).has('editorTabs')) {
	await import('../../../src/ash/workbench/contrib/modernUI/browser/media/roundedCorners.css');
	await import('../../../src/ash/workbench/contrib/modernUI/browser/media/editorBorder.css');
	// Use the same title-slot mounting as the product Auxiliary Bar.
	class ChatTabsPart extends AuxiliarybarPart {
		setChatTitle(title: PartTitleProjection): void {
			this.setTitleProjection(title);
		}
	}
	const chatHost = h(document, 'div');
	chatHost.id = 'chat-tabs-host';
	chatHost.className = 'ash-workbench modern-ui';
	chatHost.style.cssText = 'display:flex;width:800px;height:120px';
	document.body.append(chatHost);
	resources.add(toDisposable(() => chatHost.remove()));
	const chatPart = resources.add(editorServices.createInstance(ChatTabsPart, chatHost, {
		openComposite: () => { throw new Error('Composite switching is outside this fixture'); },
		viewDescriptorService: services.get(IViewDescriptorService),
	}));
	chatPart.domNode.style.cssText = 'box-sizing:border-box;width:100%;height:100%';
	let chats = [
		{ id: 'chat-alpha', label: 'Chat alpha', panelId: 'chat-alpha-panel' },
		{ id: 'chat-beta', label: 'Chat beta', panelId: 'chat-beta-panel' },
	];
	let activeChat = chats[0]!.id;
	editorServices.registerInstance(IMenuService, services.get(IMenuService));
	editorServices.registerInstance(IContextMenuService, services.get(IContextMenuService));
	const chat = resources.add(editorServices.createInstance(ChatViewTitleControl, chatPart.domNode, 'chat', () => {
		const pick = editorServices.get(IQuickInputService).createQuickPick<{ label: string; id: string; }>();
		const lifetime = new DisposableStore();
		lifetime.add(pick);
		pick.items = chats;
		lifetime.add(pick.onDidAccept(() => {
			const entry = pick.selectedItems[0];
			if (!entry) return;
			activeChat = entry.id;
			chat.update(entry.label);
			pick.hide();
		}));
		const dismissed = new Promise<void>(resolve => lifetime.add(pick.onDidHide(() => { lifetime.dispose(); resolve(); })));
		pick.show();
		return dismissed;
	}));
	chat.update(chats.find(entry => entry.id === activeChat)!.label);
	chatPart.setChatTitle(chat.partTitleProjection);
}

const badgeBars: CompositeBar[] = [];
const badgeActivities: ActivityService[] = [];
const badgeHandles = resources.add(new MutableDisposable<DisposableStore>());
if (new URLSearchParams(location.search).has('badges')) {
	for (const presentation of ['icon', 'label'] as const) {
		const host = h(document, 'div');
		host.id = `badge-${presentation}`;
		host.style.cssText = 'width:240px;height:100px';
		document.body.append(host);
		resources.add(toDisposable(() => host.remove()));
		const bar = resources.add(new CompositeBar(host, {
			presentation,
			location: ViewContainerLocation.Panel,
			viewDescriptorService: services.get(IViewDescriptorService),
			ariaLabel: 'Badge views',
			activityHoverOptions: { position: () => HoverPosition.BELOW },
			openComposite: id => views.openViewContainer(id),
		}));
		badgeBars.push(bar);
		badgeActivities.push(resources.add(new ActivityService(bar)));
	}
}
const editorRegistry = new EditorPaneRegistry();
resources.add(editorRegistry.registerEditorPane({
	id: CODE_EDITOR_ID, name: 'Text editor', canOpen: () => EditorPaneMatch.Default,
	create: () => editorServices.createInstance(TextResourceEditor, resourceStore, { lineNumbers: 'on', createPart: options => StandaloneServices.initialize().createInstance(CodeEditorWidget, options) } satisfies EditorPaneOptions),
}));
const watermarkBindings = new Map([
	['workbench.action.quickOpen', resolveKeybinding(Keybinding.single(logicalKey('p', { primaryKey: true })))],
	['workbench.action.findInFiles', resolveKeybinding(Keybinding.single(logicalKey('f', { primaryKey: true, shiftKey: true })))],
	[ShowAllCommandsCommandId, resolveKeybinding(Keybinding.single(physicalKey('F1')))],
]);
const watermarkBindingChanges = resources.add(new Emitter<void>());
const watermarkCommands: string[] = [];
// The command registry isolates dispatch assertions from file/network services.
const watermarkRegistry = new CommandRegistry();
for (const command of watermarkBindings.keys()) {
	resources.add(watermarkRegistry.register(command, () => { watermarkCommands.push(command); }));
}
const watermarkKeybindings = new URLSearchParams(location.search).has('emptyEditor') ? {
	onDidUpdateKeybindings: watermarkBindingChanges.event,
	lookupKeybinding: (command: string) => watermarkBindings.get(command),
} as IKeybindingService : undefined;
if (watermarkKeybindings) {
	await import('../../../src/ash/workbench/browser/workbench.contribution.js');
	editorServices.registerInstance(IKeybindingService, watermarkKeybindings);
	editorServices.registerInstance(ICommandService, resources.add(new CommandService(editorServices, watermarkRegistry)));
}
const editor = resources.add(editorServices.createInstance(EditorPart, editorHost, { registry: editorRegistry, configurationService: editorServices.get(IConfigurationService), keybindingService: watermarkKeybindings }));
editor.layout({ width: 800, height: 260 });
const editorPanes = new Map<string, { pane: IEditorPane; control: unknown; }>();
const editorEvents: string[] = [];
const editorInput = (name: string) => ({ resource: URI.file(`/composite/${name}.ts`), label: `${name}.ts`, initialText: `const ${name} = 1;` });
async function openEditor(name: string): Promise<void> {
	const pane = await editor.openEditor(editorInput(name), { pinned: true, preserveFocus: true });
	if (!editorPanes.has(name)) {
		editorPanes.set(name, { pane, control: pane.getControl() });
		resources.add(pane.onDidFocus(() => editorEvents.push(`${name}:focus`)));
		resources.add(pane.onDidBlur(() => editorEvents.push(`${name}:blur`)));
	}
	pane.focus();
}

window.ashCompositeIntegration = {
	setBadge: count => {
		badgeHandles.value = new DisposableStore();
		for (const activity of badgeActivities) {
			badgeHandles.value.add(activity.showViewContainerActivity('first', new NumberBadge(count, `${count} changes`)));
		}
	},
	setBadgeOrientation: orientation => {
		badgeBars[0]!.domNode.parentElement!.style.width = orientation === 'vertical' ? '48px' : '240px';
		badgeBars[0]!.setOrientation(orientation);
	},
	setBadgeCompact: compact => {
		const host = badgeBars[0]!.domNode.parentElement!;
		badgeBars[0]!.setDensity(compact ? 'compact' : 'default');
		host.style.width = compact ? '36px' : '48px';
	},
	toggleBadge: () => { badgeBars[0]!.toggleBadgeEnablement('first'); },
	events,
	editorEvents,
	partEvents,
	resize: (width, height) => {
		panel.domNode.style.width = `${width}px`;
		panel.domNode.style.height = `${height}px`;
		panel.layout({ width, height });
	},
	geometry: () => {
		const host = panel.domNode.querySelector<HTMLElement>('.ash-view-pane-container')!;
		const pane = host.querySelector<HTMLElement>('.ash-split-view-pane')!;
		const bounds = pane.getBoundingClientRect();
		return { hostWidth: host.clientWidth, hostHeight: host.clientHeight, paneWidth: bounds.width, paneHeight: bounds.height };
	},
	openEditor,
	watermarkCommands,
	setWatermarkBinding: (command, key) => {
		if (key === null) watermarkBindings.delete(command);
		else watermarkBindings.set(command, resolveKeybinding(Keybinding.single(physicalKey(key))));
		watermarkBindingChanges.fire();
	},
	resizeEditor: (width, height) => {
		editorHost.style.width = `${width}px`;
		editorHost.style.height = `${height}px`;
		editor.layout({ width, height });
	},
	configureEditorTabs: async (style, sizing = 'fit') => {
		const configuration = editorServices.get(IConfigurationService);
		await configuration.updateValue(WorkbenchConfiguration.modernUIEditorTabStyle, style);
		await configuration.updateValue(EditorTabSizingConfiguration, sizing);
	},
	setEditorTheme: id => {
		const theme = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme].find(theme => theme.id === id);
		if (!theme) throw new Error(`Unknown editor test theme: ${id}`);
		(editorServices.get(IThemeService) as TestThemeService).setColorTheme(theme);
	},
	openFileAliases: async target => {
		const workspace = resources.add(new WorkspaceContextService({ id: 'composite', uri: URI.file('/composite') }));
		const unavailable = (): never => { throw new Error('Unexpected file operation in editor identity fixture'); };
		const provider = resources.add(new AppServerFileSystemProvider({
			workspaceContextService: workspace,
			api: {
				...createDisconnectedFileApi(unavailable), readPathCaseSensitivity: async params => {
					if (params.dirId !== 'composite') throw new Error('Wrong directory owner');
					await Promise.resolve();
					return { scopes: [{ path: '.', sensitivity: 'sensitive' }, ...(params.path.includes('/') ? [{ path: params.path.split('/')[0], sensitivity: params.path.startsWith('Original/') ? 'insensitive' as const : 'sensitive' as const }] : [])] };
				}
			}, resourceApi: { connectionGeneration: 0, metadata: unavailable, read: unavailable, release: unavailable },
		}));
		resources.add(uriIdentityServices.get(IFileService).registerProvider('file', provider));
		const lower = { resource: URI.file('/composite/Original/Alias.txt'), initialText: 'original content' };
		const firstPane = await editor.openEditor(lower, { pinned: true }, target);
		const firstModel = models.getModel(lower.resource)!;
		firstModel.setValue('unsaved content');
		const identity = uriIdentityServices.get(IUriIdentityService);
		for (let index = 0; index < 4097; index++) await identity.resolveCanonicalUri(URI.file(`/composite/transient${index}/File`));
		const alias = resources.add(new FileEditorInput(URI.file('/composite/Original/ALIAS.txt')));
		const secondPane = await editor.openEditor(alias, { pinned: true }, target);
		return { tabs: editor.activeGroup.inputs.length, models: models.getModels().length, retained: firstPane === secondPane && firstModel === models.getModel(alias.resource), text: firstModel.getText() };
	},
	closeEditor: async name => { await editor.closeEditor(editorInput(name)); },
	editorState: () => [...editorPanes].map(([name, { pane, control }]) => ({ name, focused: pane.hasFocus(), visible: pane.isVisible(), retained: control === pane.getControl() })),
	state: () => [...composites].map(([id, composite]) => ({
		id: composite.getId(), title: composite.getTitle(), focused: composite.hasFocus(),
		retained: panel.getComposite(id) === composite && composite.getControl() === panel.getComposite(id)!.getControl(),
	})),
	open: async (id, focus) => { await views.openViewContainer(id, focus); },
	hide: () => views.closeViewContainer(panes.getActivePaneComposite(ViewContainerLocation.Panel)!.getId()),
	openView: async id => { await views.openView(id, true); },
	dispose: () => panel.dispose(),
	flushPaneState: async () => {
		const key = 'workbench.viewContainer.first.first.view.size';
		storage.remove(key, StorageScope.WORKSPACE);
		await storage.flush();
		return storage.getNumber(key, StorageScope.WORKSPACE);
	},
	reattachDisposed: () => {
		const input = h(document, 'input');
		input.setAttribute('aria-label', 'Disposed input');
		firstRoot.hidden = false;
		firstRoot.append(input);
		document.body.append(firstRoot);
		resources.add(toDisposable(() => firstRoot.remove()));
	},
};

// Exercise the same Sessions view-to-editor binding without an agent backend.
const sessionHost = h(document, 'section');
sessionHost.id = 'session-grid';
sessionHost.style.cssText = 'position:relative;display:flex;width:1000px;height:400px';
document.body.append(sessionHost);
resources.add(toDisposable(() => sessionHost.remove()));
const sessionViews = new Map<string, IView>();
const emptySessionView: IView = {
	element: h(document, 'div'), minimumWidth: 0, maximumWidth: Infinity, minimumHeight: 0, maximumHeight: Infinity,
	layout() { },
};
const sessionServices = resources.add(editorServices.createChild());
sessionServices.registerInstance(IStorageService, storage);
const sessionGrid = resources.add(sessionServices.createInstance(SessionGridLayout, sessionHost, emptySessionView));
sessionGrid.layout(1000, 400);
let sessionIds: readonly string[] = [];
let activeSessionId = '';
async function showSessions(ids: readonly string[], active: string): Promise<void> {
	sessionIds = ids;
	activeSessionId = active;
	sessionGrid.reconcile(ids.map(id => {
		let view = sessionViews.get(id);
		if (!view) {
			const element = h(document, 'div');
			const input = h(document, 'input');
			input.setAttribute('aria-label', `${id} prompt`);
			element.append(input);
			view = { element, minimumWidth: 100, maximumWidth: Infinity, minimumHeight: 100, maximumHeight: Infinity, layout() { } };
			sessionViews.set(id, view);
		}
		return {
			id, view, label: id,
			activate: () => { activeSessionId = id; },
			close: () => { void showSessions(sessionIds.filter(candidate => candidate !== id), sessionIds.find(candidate => candidate !== id)!); },
			focus: () => view.element.querySelector('input')!.focus(),
		};
	}), active);
	await sessionGrid.whenReady();
}
window.ashSessionGridIntegration = {
	show: showSessions,
	active: () => activeSessionId,
	replace: id => showSessions(sessionIds.map(candidate => candidate === activeSessionId ? id : candidate), id),
};
