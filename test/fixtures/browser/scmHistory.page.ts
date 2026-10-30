import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/scm/browser/scm.contribution.js';
import { Button } from '../../../src/ash/base/browser/ui/button/button.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { observableValue } from '../../../src/ash/base/common/observable.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../src/ash/platform/actions/common/actions.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { HoverConfiguration } from '../../../src/ash/platform/hover/common/hoverService.js';
import { ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { bindTestColorTheme } from './themeFixture.js';
import { defaultButtonStyles } from '../../../src/ash/platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import type { IEditorOptions } from '../../../src/ash/platform/editor/common/editor.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IProgressService } from '../../../src/ash/platform/progress/common/progress.js';
import { SCMHistoryViewPane } from '../../../src/ash/workbench/contrib/scm/browser/scmHistoryViewPane.js';
import { ViewPane, ViewPaneShowActions, type IViewPaneOptions } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../src/ash/workbench/browser/parts/views/viewPaneContainer.js';
import { ViewContainerLocation, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { SCMViewService } from '../../../src/ash/workbench/contrib/scm/browser/scmViewService.js';
import { SCMService } from '../../../src/ash/workbench/contrib/scm/common/scmService.js';
import { ISCMService, ISCMViewService } from '../../../src/ash/workbench/contrib/scm/common/scm.js';
import type { ISCMHistoryItem, ISCMHistoryProvider } from '../../../src/ash/workbench/contrib/scm/common/history.js';
const resources = new DisposableStore();
let toolbarCalls = 0;
if (new URLSearchParams(location.search).has('toolbarOverflow')) {
	for (const [index, name] of ['Fetch', 'Pull', 'Push'].entries()) {
		resources.add(registerAction2(class extends Action2 {
			constructor() {
				super({ id: `fixture.history.${name}`, title: name, icon: Lxicon.sync, menu: { id: MenuId.SCMHistoryTitle, group: 'navigation', order: 900 + index } });
			}
			override run(): void { toolbarCalls++; }
		}));
	}
}
resources.add(setARIAContainer(document.body));
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const root = document.querySelector<HTMLElement>('#history-root')!;
const configuration = resources.add(new WorkbenchConfigurationService());
const dependencies = resources.add(createTestEditorServices(configuration));
registerCodeEditorServices(dependencies);
const services = resources.add(dependencies.createChild());
const themes = services.get(IThemeService) as TestThemeService;
themes.setColorTheme(lightColorTheme);
resources.add(bindTestColorTheme(themes, root));
services.registerInstance(ILayoutService, { mainContainer: root } as ILayoutService);
services.registerInstance(ICommandService, resources.add(new CommandService(services)));
services.registerInstance(IProgressService, { withProgress: (_options, task) => task({ report() { } }) });
services.registerInstance(IMenuService, services.createInstance(MenuService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, services.get(IContextViewService), services.get(IContextMenuService))));
services.registerInstance(IAccessibleViewService, resources.add(services.createInstance(AccessibleViewService)));
services.registerInstance(IClipboardService, new BrowserClipboardService(navigator.clipboard));
// Editor transport is covered by smoke; this fixture owns only row and hover rendering.
const opened: { resource: string; options: IEditorOptions | undefined; group: unknown; }[] = [];
services.registerInstance(IEditorService, { openEditor: async (input: IResourceEditorInput, options?: IEditorOptions, group?: unknown) => { opened.push({ resource: input.resource.toString(), options, group }); } } as unknown as IEditorService);
const scm = resources.add(new SCMService());
const view = resources.add(new SCMViewService(scm));
services.registerInstance(ISCMService, scm);
services.registerInstance(ISCMViewService, view);
const hash = 'a'.repeat(40);
const timestamp = 1_700_000_000;
const subject = `History metadata: a long title that uses the space previously occupied by the commit hash and date ${'long-commit-identifier'.repeat(6)}`;
const message = new URLSearchParams(location.search).has('markdown') ? [
	'## Why', '', 'Render **commit details** with `Markdown`.', '',
	'## What changed', '', '- Headings and lists', '- [Documentation](https://example.invalid/docs)', '',
	'```ts', 'const message = "rendered";', '```', '',
	'<script>window.commitScriptRan = true</script>', '',
	'[Unsafe command](command:workbench.action.closeWindow)',
].join('\n') : Array.from({ length: 24 }, (_, index) => `    Detail ${index + 1}: the complete explanation remains available without taking space from the history title.`).join('\n');
const historyChanged = resources.add(new Emitter<void | { readonly silent: boolean }>());
const repositoryChanged = resources.add(new Emitter<void>());
let repositoryBusy = false;
let heldHistory: DeferredPromise<void> | undefined;
const pagingQuery = new URLSearchParams(location.search);
const paging = pagingQuery.has('paging');
if (paging) {
	await configuration.updateValue('scm.graph.pageSize', 80);
	await configuration.updateValue('scm.graph.pageOnScroll', !pagingQuery.has('manual'));
}
let historyItems: readonly ISCMHistoryItem[] | undefined = paging ? Array.from({ length: 320 }, (_, index) => ({
	id: `paging-${index}`, parentIds: index < 319 ? [`paging-${index + 1}`] : [],
	subject: `Paging commit ${index}`, message: `Paging details ${index}`,
})) : undefined;
const historyReads: { skip: number; limit: number; }[] = [];
let changeReads = 0;
const heldContents = new Map<string, DeferredPromise<void>>();
const completedContents: string[] = [];
const provider: ISCMHistoryProvider = {
	onDidChange: historyChanged.event,
	historyItemRef: observableValue('fixture.history.head', undefined),
	refresh() { },
	provideHistoryItems: async options => {
		historyReads.push({ skip: options.skip ?? 0, limit: options.limit ?? 50 });
		await heldHistory?.p;
		if (historyItems) return historyItems.slice(options.skip ?? 0, (options.skip ?? 0) + (options.limit ?? 50));
		return [{ id: hash, displayId: hash.slice(0, 7), parentIds: [], subject, message, tooltip: { authorName: 'History Author', authorEmail: 'history@example.invalid', timestamp: timestamp * 1000, message, statistics: { files: 2, additions: 2, deletions: 0 } }, remoteLinks: [{ name: 'origin', uri: URI.parse(`https://github.com/ash-test/history/commit/${hash}`) }], references: [{ id: 'localBranch:metadata-topic', name: 'metadata-topic', category: 'localBranch' }, { id: 'tag:metadata-v1', name: 'metadata-v1', category: 'tag' }] }];
	},
	provideHistoryItemChanges: async () => {
		changeReads++;
		const query = new URLSearchParams(location.search);
		const paths = query.has('manyChanges') ? Array.from({ length: 200 }, (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`) : query.has('changes') ? ['src/first.ts', 'src/second.ts', 'README.md'] : [];
		return paths.map(path => ({ path, uri: URI.file(`/workspace/${path}`), status: 'modified' }));
	},
	resolveHistoryItemChangeContents: async (_id, change) => {
		await heldContents.get(change.path)?.p;
		completedContents.push(change.path);
		return { parentId: 'fixture-base', original: { kind: 'text', text: 'Before' }, modified: { kind: 'text', text: 'After' } };
	},
	resolveHistoryItemChatContext: async () => undefined,
	resolveHistoryItemChangeRangeChatContext: async () => undefined,
};
resources.add(scm.registerSCMProvider({
	id: 'fixture.history', providerId: 'git', label: 'History', rootUri: URI.file('/workspace'), groups: [], onDidChangeResources: repositoryChanged.event,
	input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
	activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', get isBusy() { return repositoryBusy; }, historyProvider: provider,
	refresh: async () => { }, activate: async () => { },
}));
const registry = new WorkbenchViewRegistry();
const viewContainer = { id: 'fixture.history.container', title: 'History fixture', location: ViewContainerLocation.Sidebar };
resources.add(registry.registerViewContainer(viewContainer));
resources.add(registry.registerViews(viewContainer.id, [{ id: 'fixture.history', title: 'History', ctorDescriptor: new SyncDescriptor(SCMHistoryViewPane) }]));
class HeaderActionsPane extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, { ...options, showActions: options.id === 'always' ? ViewPaneShowActions.Always : ViewPaneShowActions.Default });
		this._register(new Button(this.headerActionsElement, { ...defaultButtonStyles, label: 'Fixture action' }));
	}
}
if (new URLSearchParams(location.search).has('headerActions')) {
	resources.add(registry.registerViews(viewContainer.id, ['default', 'always'].map(id => ({ id, title: id, ctorDescriptor: new SyncDescriptor(HeaderActionsPane) }))));
}
const descriptors = resources.add(services.createInstance(ViewDescriptorService, { registry }));
const panes = resources.add(services.createInstance(ViewPaneContainer, root, {
	viewContainer, model: descriptors.getViewContainerModel(viewContainer.id)!,
}));
panes.layout({ height: 600, width: 560 });
panes.setVisible(true);
const fixture = {
	hash, timestamp, subject, message, opened, historyReads,
	get toolbarCalls(): number { return toolbarCalls; },
	setHoverDelay(delay: number): Promise<void> { return configuration.updateValue(HoverConfiguration.delay, delay); },
	get changeReads(): number { return changeReads; },
	setRepositoryBusy(value: boolean): void { repositoryBusy = value; repositoryChanged.fire(); },
	completedContents,
	holdContents(paths: string[]): void { for (const path of paths) heldContents.set(path, new DeferredPromise<void>()); },
	finishContents(path: string): void { void heldContents.get(path)?.complete(); heldContents.delete(path); },
	setViewMode(mode: 'list' | 'tree'): void { (panes.getView('fixture.history') as SCMHistoryViewPane).setViewMode(mode); },
	refresh(): void { historyChanged.fire(); },
	manualRefresh(): Promise<void> { return (panes.getView('fixture.history') as SCMHistoryViewPane).runTitleOperation(); },
	prependHistoryItem(id: string, silent = false): void {
		historyItems = [{ id, parentIds: historyItems?.length ? [historyItems[0].id] : [], subject: id, message: id }, ...historyItems ?? []];
		historyChanged.fire({ silent });
	},
	async setHistoryItems(prefix: string): Promise<void> {
		await configuration.updateValue('scm.graph.pageSize', 200);
		historyItems = Array.from({ length: 100 }, (_, index) => ({
			id: `${prefix}-${index}`, parentIds: index < 99 ? [`${prefix}-${index + 1}`] : [],
			subject: `${prefix} commit ${index}`, message: `${prefix} details ${index}`,
		}));
		historyChanged.fire();
	},
	beginHistoryRead(): void { heldHistory = new DeferredPromise<void>(); historyChanged.fire(); },
	holdNextHistoryPage(): void { heldHistory = new DeferredPromise<void>(); },
	setPageOnScroll(value: boolean): Promise<void> { return configuration.updateValue('scm.graph.pageOnScroll', value); },
	finishHistoryRead(fail = false): void {
		const pending = heldHistory;
		heldHistory = undefined;
		if (fail) void pending?.error(new Error('History unavailable'));
		else void pending?.complete();
	},
	resize(width: number): void { root.style.width = `${width}px`; panes.layout({ height: 600, width }); },
	setAlwaysShowHeaderActions(value: unknown): Promise<void> { return configuration.updateValue('workbench.view.alwaysShowHeaderActions', value); },
	addDefaultView(): void { resources.add(registry.registerViews(viewContainer.id, [{ id: 'late-default', title: 'Late default', ctorDescriptor: new SyncDescriptor(HeaderActionsPane) }])); },
	setTheme(index: number): void { themes.setColorTheme([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]!); },
};
declare global { interface Window { ashSCMHistoryIntegration: typeof fixture; } }
window.ashSCMHistoryIntegration = fixture;
