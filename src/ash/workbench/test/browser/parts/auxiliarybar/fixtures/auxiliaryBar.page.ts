import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import { Dimension } from '../../../../../../base/browser/dom.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setNlsMessages } from '../../../../../../nls.js';
import { IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { WorkbenchState } from '../../../../../../platform/workspace/common/workspace.js';
import { WorkbenchLayout } from '../../../../../browser/layout.js';
import { Part } from '../../../../../browser/part.js';
import { AuxiliaryBarPart } from '../../../../../browser/parts/auxiliarybar/auxiliaryBarPart.js';
import { PaneCompositePartService } from '../../../../../browser/parts/paneCompositePartService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../browser/parts/views/viewPane.js';
import { WorkbenchConfiguration } from '../../../../../common/configuration.js';
import { IViewDescriptorService, ViewContainerLocation, WorkbenchViewRegistry } from '../../../../../common/views.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, workbenchPartIds, type WorkbenchPartId } from '../../../../../services/layout/browser/layoutService.js';
import { ILocalizationService } from '../../../../../services/localization/common/localizationService.js';
import { IPaneCompositePartService } from '../../../../../services/panecomposite/browser/panecomposite.js';
import { ViewDescriptorService } from '../../../../../services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IActivityService } from '../../../../../services/activity/common/activity.js';
import { ActivityService } from '../../../../../services/activity/browser/activityService.js';
import { ViewsService } from '../../../../../services/views/browser/viewsService.js';
import { createTestEditorServices } from '../../../../common/testEditorServices.js';
import { createTestWorkbenchContextKeysHandler } from '../../../../common/testWorkbenchContextKeys.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { h, addDisposableListener } from '../../../../../../base/browser/dom.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ActivityBarPosition } from '../../../../../common/configuration.js';
import type { PartTitleProjection } from '../../../../../browser/parts/views/viewPane.js';
import { HoverService, IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import chinese from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

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
await import('../../../../../browser/parts/auxiliarybar/auxiliaryBarActions.js');

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
			state(): { maximized: boolean; width: number; saved: import('../../../../../browser/layout.js').WorkbenchLayoutState; active: string | undefined; };
		};
	}
}
