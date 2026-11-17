import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import '../../../../../base/browser/ui/styles.css';
import '../../../../browser/media/style.css';
import '../../../../contrib/accessibility/browser/accessibilityConfiguration.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { setNlsMessages } from '../../../../../nls.js';
import { IExtensionHostApi, type ExtensionHostInvocationRequest, type JsonValue } from '../../../../../platform/extensions/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../../../platform/extensions/browser/extensionHostApi.js';
import { normalizeExtensionHostSnapshot } from '../../../../../platform/extensions/browser/extensionHostProtocol.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IMenuService, MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { BrowserContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IViewDescriptorService, WorkbenchViewRegistry, ViewContainerLocation, ViewsRegistry } from '../../../../common/views.js';
import { HoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { setHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { MainThreadTreeViews } from '../../../browser/mainThreadTreeViews.js';
import { PaneComposite } from '../../../../browser/panecomposite.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestNotificationService } from '../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { Event } from '../../../../../base/common/event.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { noFileIconTheme } from '../../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ITreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDndService.js';
import { TreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDnd.js';
import type { VSDataTransfer } from '../../../../../base/common/dataTransfer.js';

const params = new URLSearchParams(location.search);
if (params.get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const contexts = resources.add(new ContextKeyService());
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IContextKeyService, contexts);
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'tree-integration', flushInterval: 0 })));
const theme = resources.add(new TestThemeService(params.has('hc') ? highContrastDarkColorTheme : params.has('dark') ? darkColorTheme : lightColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, document.querySelector<HTMLElement>('#root')!));
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
const commands: unknown[][] = [];
services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
services.registerInstance(IMarkdownRendererService, { _serviceBrand: undefined, render: renderMarkdown, setDefaultCodeBlockRenderer() { } });
services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: Event.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() { } });
services.registerInstance(ITreeViewsDnDService, new TreeViewsDnDService<VSDataTransfer>());
const iconReads: string[] = [];
services.registerInstance(IFileService, { readFileBytes: async (resource: import('../../../../../base/common/uri.js').URI) => {
	iconReads.push(resource.path);
	return { resource, revision: '1', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="currentColor"/></svg>') };
} } as unknown as IFileService);
services.registerInstance(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService);
services.registerInstance(IMenuService, services.createInstance(MenuService));
const editableItem = ContextKeyExpr.and(ContextKeyExpr.equals('view', 'test.tree'), ContextKeyExpr.equals('viewItem', 'editable'));
resources.add(MenusRegistry.appendMenuItem(MenuId.for('view/item/context'), { command: { id: 'test.inspect', title: 'Inspect item' }, group: 'inline', when: editableItem }));
resources.add(MenusRegistry.appendMenuItem(MenuId.for('view/item/context'), { command: { id: 'test.more', title: 'More item actions' }, when: editableItem }));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
const menus = resources.add(new BrowserContextMenuService(services.get(IMenuService), contexts, { lookupKeybinding: () => undefined } as unknown as IKeybindingService, services.get(IContextViewService), services.get(INotificationService)));
services.registerInstance(IContextMenuService, menus);
resources.add(setHoverDelegate(resources.add(new HoverService(configuration, services.get(IContextViewService), menus))));
if (params.has('empty')) { resources.add(ViewsRegistry.registerViewWelcomeContent('test.tree', { content: 'Provider welcome' })); }
const registry = resources.add(new WorkbenchViewRegistry());
const first = { id: 'test.first', title: 'First', location: ViewContainerLocation.Sidebar, isDefault: true };
const second = { id: 'test.second', title: 'Second', location: ViewContainerLocation.AuxiliaryBar };
resources.add(registry.registerViewContainer(first));
resources.add(registry.registerViewContainer(second));
const descriptors = resources.add(services.createInstance(ViewDescriptorService, { registry }));
services.registerInstance(IViewDescriptorService, descriptors);
const composites = [first, second].map((descriptor, index) => {
	const composite = resources.add(services.createInstance(PaneComposite, document.querySelector<HTMLElement>(index ? '#second' : '#first')!, {
		viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id), onDidFailCreateView: (error: unknown) => { throw error; },
	}));
	composite.setVisible(true);
	composite.layout({ width: 320, height: 480 });
	return composite;
});
const api = createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected ${operation}`); });
services.registerInstance(IExtensionHostApi, api);
let label = 'Child';
let checked = false;
let pending: DeferredPromise<JsonValue> | undefined;
const signals: AbortSignal[] = [];
const requests: ExtensionHostInvocationRequest[] = [];
api.invoke = async (request, signal) => {
	signals.push(signal);
	requests.push(request);
	signal.throwIfAborted();
	const payload = request.payload as { method: string; handle?: string; value?: string; isChecked?: boolean; };
	if (payload.method === 'children') {
		if (params.has('empty')) { return []; }
		if (pending) { return pending.p; }
		return payload.handle === 'root'
			? [{ handle: 'child', label, collapsibleState: 0, checkboxState: checked ? 1 : 0, editable: true, description: 'Provider owned',
				...(params.has('rich') ? { highlights: [[0, 2]], themeIcon: { id: 'file' }, contextValue: 'editable', resourceUri: { scheme: 'file', path: '/fixture/child.ts' }, tooltip: { value: '**Provider** tooltip' }, accessibilityInformation: { label: 'Provider child' } } : {}),
				...(params.has('customIcons') ? { icon: { scheme: 'file', path: '/fixture/light.svg' }, iconDark: { scheme: 'file', path: '/fixture/dark.svg' } } : {}),
				command: { id: 'test.open', arguments: ['child'] } }]
			: [{ handle: 'root', label: 'Root', collapsibleState: 1 }];
	}
	if (payload.method === 'rename') { label = payload.value!; }
	if (payload.method === 'checkbox') { checked = payload.isChecked!; }
	if (payload.method === 'drag') { return { 'text/plain': 'Dragged child' }; }
	return null;
};
const source = { extensionId: 'test.tree', activationGeneration: 1, incarnation: 1 };
const snapshot = normalizeExtensionHostSnapshot({
	generation: 1, extensions: [{
		id: source.extensionId, version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
		activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
		registrations: [{ kind: 'treeDataProvider', registrationId: 'tree', viewId: 'test.tree', title: 'Extension Tree' }],
	}]
});
services.registerInstance(IViewsService, { openView: async (id: string) => composites.flatMap(composite => composite.panes).find(pane => pane.id === id) ?? null } as unknown as IViewsService);
const bridge = resources.add(services.createInstance(MainThreadTreeViews, 1_000));
bridge.update(snapshot);

declare global {
	interface Window {
		treeIntegration: {
			requests(): readonly ExtensionHostInvocationRequest[]; commands(): unknown[][]; refresh(value: string, handle?: string): void;
			operation(action: string, handles?: string[], options?: JsonValue): Promise<void>;
			iconReads(): readonly string[];
			move(): void; stop(): void; block(): void; release(): void; aborted(): boolean; stale(): boolean;
			accessible(help: boolean): string | undefined; verbosity(value: boolean): void; dispose(): void;
		};
	}
}
window.treeIntegration = {
	requests: () => requests, commands: () => commands,
	iconReads: () => iconReads,
	operation: (action, handles, options) => bridge.handleOperation({ method: 'treeViewOperation', registrationId: 'tree', action, ...(handles ? { handles } : {}), ...(options === undefined ? {} : { options }) }, source, new AbortController().signal),
	refresh: (value, handle) => { label = value; bridge.handleChange({ method: 'treeViewChanged', registrationId: 'tree', ...(handle ? { handles: [handle] } : {}) }, source); },
	move: () => descriptors.moveViewsToContainer([descriptors.getViewDescriptorById('test.tree')!], second),
	stop: () => bridge.clear(),
	block: () => { pending = new DeferredPromise<JsonValue>(); bridge.handleChange({ method: 'treeViewChanged', registrationId: 'tree' }, source); },
	release: () => { void pending?.complete([{ handle: 'late', label: 'Retired result', collapsibleState: 0 }]); pending = undefined; },
	aborted: () => signals.at(-1)?.aborted ?? false,
	stale: () => { try { bridge.handleChange({ method: 'treeViewChanged', registrationId: 'tree' }, source); return false; } catch { return true; } },
	accessible: help => {
		const implementation = AccessibleViewRegistry.getImplementations().find(value => value.name === 'tree-test.tree' && value.type === (help ? AccessibleViewType.Help : AccessibleViewType.View));
		const provider = implementation?.getProvider(services);
		if (!provider) { return undefined; }
		const content = provider.provideContent();
		provider.dispose();
		return content;
	},
	verbosity: value => { void configuration.updateValue(AccessibilityVerbositySettingId.TreeView, value); },
	dispose: () => resources.dispose(),
};
