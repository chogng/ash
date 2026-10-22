import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import { Dimension } from '../../../src/ash/base/browser/dom.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { WorkbenchState } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkbenchLayout } from '../../../src/ash/workbench/browser/layout.js';
import { Part } from '../../../src/ash/workbench/browser/part.js';
import { AuxiliaryBarPart } from '../../../src/ash/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.js';
import { PaneCompositePartService } from '../../../src/ash/workbench/browser/parts/paneCompositePartService.js';
import { ViewPane, type IViewPaneOptions } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import { WorkbenchConfiguration } from '../../../src/ash/workbench/common/configuration.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, workbenchPartIds, type WorkbenchPartId } from '../../../src/ash/workbench/services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IPaneCompositePartService } from '../../../src/ash/workbench/services/panecomposite/browser/panecomposite.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IActivityService } from '../../../src/ash/workbench/services/activity/common/activity.js';
import { ActivityService } from '../../../src/ash/workbench/services/activity/browser/activityService.js';
import { ViewsService } from '../../../src/ash/workbench/services/views/browser/viewsService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { createTestWorkbenchContextKeysHandler } from '../../../src/ash/workbench/test/common/testWorkbenchContextKeys.js';
import { bindTestColorTheme } from './themeFixture.js';
import { h, addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { ContextKeyExpr } from '../../../src/ash/platform/contextkey/common/contextkey.js';
import { ActivityBarPosition } from '../../../src/ash/workbench/common/configuration.js';
import type { PartTitleProjection } from '../../../src/ash/workbench/browser/parts/views/viewPane.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const root = document.querySelector<HTMLElement>('#app')!;
const baseServices = resources.add(createTestEditorServices());
const services = resources.add(baseServices.createChild());
const context = services.get(IContextKeyService);
const commands = resources.add(new CommandService(services));
services.registerInstance(IMenuService, new MenuService(commands, context));
services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } });
const contextViews = resources.add(new BrowserContextViewService(root));
services.registerInstance(IHoverService, resources.add(new HoverService(services.get(IConfigurationService), contextViews, services.get(IContextMenuService))));
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, root));
if (new URLSearchParams(location.search).has('chinese')) setNlsMessages('zh-CN', chinese);
await import('../../../src/ash/workbench/browser/parts/auxiliarybar/auxiliaryBarActions.js');

class DraftView extends ViewPane {
	private readonly input: HTMLTextAreaElement;
	private readonly titleControl = h(document, 'button');
	private readonly titleActions = h(document, 'button');
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.input = document.createElement('textarea');
		this.input.setAttribute('aria-label', 'Chat draft');
		this.contentElement.append(this.input);
		this.titleControl.textContent = 'Chat title control';
		this.titleActions.textContent = 'Clear draft';
		this._register(addDisposableListener(this.titleActions, 'click', () => { this.input.value = ''; }));
	}
	public override focus(): void { this.input.focus(); }
	public override get partTitleProjection(): PartTitleProjection { return { content: this.titleControl, actions: this.titleActions }; }
}
const registry = resources.add(new WorkbenchViewRegistry());
registry.registerStaticViewContainer({ id: 'test.chat', title: 'Chat', location: ViewContainerLocation.AuxiliaryBar, isDefault: true });
registry.registerStaticViews('test.chat', [{ id: 'test.chat.draft', title: 'Chat', ctorDescriptor: new SyncDescriptor(DraftView) }]);
resources.add(registry.registerViewContainer({ id: 'test.other', title: 'Other', location: ViewContainerLocation.AuxiliaryBar, hideIfEmpty: true }));
resources.add(registry.registerViews('test.other', [{ id: 'test.other.view', title: 'Other', when: ContextKeyExpr.has('test.otherActive'), ctorDescriptor: new SyncDescriptor(DraftView) }]));
services.registerInstance(IViewDescriptorService, resources.add(services.createInstance(ViewDescriptorService, { registry })));
services.registerSingleton(IActivityService, () => services.createInstance(ActivityService));
const layout = resources.add(services.createInstance(WorkbenchLayout, root, { workbenchState: WorkbenchState.FOLDER, initialDimension: new Dimension(innerWidth, innerHeight), defaultLayout: { parts: { panel: true } } }));
services.registerInstance(IWorkbenchLayoutService, layout);
const auxiliary = resources.add(services.createInstance(AuxiliaryBarPart, root));
class ContentPart extends Part {
	public readonly input = document.createElement('input');
	constructor(private readonly partId: WorkbenchPartId) {
		super(root, partId, theme, services.get(IStorageService));
		this.input.setAttribute('aria-label', partId);
		this.contentDomNode.append(this.input);
	}
	public override get minimumWidth(): number { return this.partId === 'activitybar' ? 48 : 0; }
	public override get maximumWidth(): number { return this.partId === 'activitybar' ? 48 : Infinity; }
	public override get minimumHeight(): number { return this.partId === 'titlebar' || this.partId === 'statusbar' ? 28 : 0; }
	public override get maximumHeight(): number { return this.partId === 'titlebar' || this.partId === 'statusbar' ? 28 : Infinity; }
}
const parts = new Map<WorkbenchPartId, Part>();
for (const id of workbenchPartIds) parts.set(id, id === 'auxiliarybar' ? auxiliary : resources.add(new ContentPart(id)));
layout.createParts(parts);
layout.layout(new Dimension(innerWidth, innerHeight));
const panes = resources.add(services.createInstance(PaneCompositePartService, new Map([[ViewContainerLocation.AuxiliaryBar, auxiliary]])));
services.registerInstance(IPaneCompositePartService, panes);
services.registerInstance(IViewsService, resources.add(services.createInstance(ViewsService)));
services.registerInstance(IEditorGroupsService, { activeGroup: { focus: () => (parts.get('editor') as ContentPart).input.focus() } } as unknown as IEditorGroupsService);
resources.add(createTestWorkbenchContextKeysHandler(context, { layoutService: layout }));
await panes.openPaneComposite('test.chat', ViewContainerLocation.AuxiliaryBar);
const resize = (): void => layout.layout(new Dimension(innerWidth, innerHeight));
window.addEventListener('resize', resize);
resources.add(toDisposable(() => window.removeEventListener('resize', resize)));

window.ashAuxiliaryBarIntegration = {
	command: id => commands.executeCommand(id),
	setTheme: index => theme.setColorTheme([lightColorTheme, darkColorTheme, highContrastLightColorTheme, highContrastDarkColorTheme][index]!),
	setSide: side => services.get(IConfigurationService).updateValue(WorkbenchConfiguration.sideBarLocation, side),
	setLocation: position => services.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarLocation, position),
	setAutoHide: value => services.get(IConfigurationService).updateValue(WorkbenchConfiguration.activityBarAutoHide, value),
	setOtherActive: value => context.setContext('test.otherActive', value),
	moveOther: location => {
		const descriptors = services.get(IViewDescriptorService);
		descriptors.moveViewContainerToLocation(descriptors.getViewContainerById('test.other')!, location);
	},
	state: () => ({ maximized: layout.isAuxiliaryBarMaximized(), width: layout.getPartSize('auxiliarybar').width, saved: layout.state, active: auxiliary.activeCompositeId }),
};

declare global {
	interface Window {
		ashAuxiliaryBarIntegration: {
			command(id: string): Promise<unknown>;
			setTheme(index: number): void;
			setSide(side: 'left' | 'right'): Promise<void>;
			setLocation(position: ActivityBarPosition): Promise<void>;
			setAutoHide(value: boolean): Promise<void>;
			setOtherActive(value: boolean): void;
			moveOther(location: ViewContainerLocation): void;
			state(): { maximized: boolean; width: number; saved: import('../../../src/ash/workbench/browser/layout.js').WorkbenchLayoutState; active: string | undefined; };
		};
	}
}
