import { IActivityService } from '../../../services/activity/common/activity.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/auxiliaryBarPart.css";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { ViewContainerLocation } from "../../../common/views.js";
import { ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { PaneCompositePart } from "../paneCompositePart.js";
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { addDisposableListener, Dimension, h } from '../../../../base/browser/dom.js';
import { Separator } from '../../../../base/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../common/configuration.js';
import { VisibleViewContainersTracker } from '../visibleViewContainersTracker.js';
import type { PartTitleProjection } from '../views/viewPane.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';

/**
 * Secondary Pane Composite region.
 *
 * Views retain their title controls; this Part owns container selection,
 * placement and the retained Composite lifecycle.
 */
export class AuxiliaryBarPart extends PaneCompositePart {
	private readonly visibleViewContainersTracker: VisibleViewContainersTracker;
	private readonly selectorHost: HTMLDivElement;
	private readonly titleHost: HTMLDivElement;
	private readonly activeTitle: HTMLSpanElement;

	override get minimumWidth(): number {
		// The content minimum excludes this Part's one-pixel left border; Grid adds frame insets.
		return Math.max(180, super.minimumWidth + 1);
	}
	override get maximumWidth(): number { return Number.POSITIVE_INFINITY; }
	override get preferredWidth(): number | undefined {
		const active = this.activeCompositeId;
		return active ? Math.max(this.getComposite(active)!.getOptimalWidth(), 300) : undefined;
	}

	constructor(
		container: HTMLElement,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILocalizationService localizationService: ILocalizationService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActivityService activityService: IActivityService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService hoverService: IHoverService,
	) {
		super(container, {
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
			viewDescriptorService,
			contextKeyService,
			localizationService,
			id: "auxiliarybar",
			location: ViewContainerLocation.AuxiliaryBar,
			ariaLabel: "Auxiliary sidebar",
			ariaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebar" },
			viewsAriaLabel: "Auxiliary sidebar views",
			viewsAriaLabelKey: { bundle: "ash.regions", key: "auxiliarySidebarViews" },
			compositeBarContextMenuProvider: contextMenuService,
			titleActions: { menuService, contextMenuProvider: contextMenuService, menuId: MenuId.AuxiliaryBarTitle },
		}, themeService, storageService, activityService);
		this.contentDomNode.classList.add("ash-auxiliarybar-content");
		this.selectorHost = h(container.ownerDocument, 'div');
		this.selectorHost.className = 'ash-auxiliarybar-view-selector';
		this.titleHost = h(container.ownerDocument, 'div');
		this.titleHost.className = 'ash-auxiliarybar-title-content';
		this.activeTitle = h(container.ownerDocument, 'span');
		this.activeTitle.className = 'ash-auxiliarybar-title-label';
		this._register(hoverService.setupDelayedHover(this.activeTitle, () => ({ content: this.activeTitle.textContent ?? '' })));
		const showSelectorMenu = (event: MouseEvent | KeyboardEvent): void => {
			this.compositeBar.showContextMenu(event, [], {
				transformContextMenuActionsForComposite: (actions, id) => {
					using context = contextKeyService.createScoped(h(container.ownerDocument, 'div'));
					context.setContext('viewContainer', id);
					context.setContext('viewContainerLocation', ViewContainerLocation.AuxiliaryBar);
					const groups = menuService.getMenuActions(MenuId.ViewContainerTitleContext, { arg: id }, context);
					return Separator.join([...actions], ...groups.map(([, items]) => [...items]));
				},
			});
		};
		this._register(addDisposableListener(this.compositeBar.domNode, 'contextmenu', showSelectorMenu));
		this._register(addDisposableListener(this.compositeBar.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
				showSelectorMenu(event);
			}
		}));
		this.visibleViewContainersTracker = this._register(instantiationService.createInstance(VisibleViewContainersTracker, ViewContainerLocation.AuxiliaryBar));
		this._register(this.visibleViewContainersTracker.onDidChange(({ before, after }) => {
			if ((before > 1) !== (after > 1)) {
				this.updateContainerSelector();
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.activityBarLocation) || event.affectsConfiguration(WorkbenchConfiguration.activityBarAutoHide)) {
				this.updateContainerSelector();
			}
		}));
		this.updateContainerSelector();
	}

	override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		const composite = this.getComposite(compositeId);
		this.setTitleProjection(composite?.partTitleProjection);
	}

	private updateContainerSelector(): void {
		const active = this.activeCompositeId ? this.getComposite(this.activeCompositeId) : undefined;
		this.setTitleProjection(active?.partTitleProjection);
	}

	protected override setTitleProjection(projection: PartTitleProjection | undefined): void {
		const focused = this.compositeBar.domNode.contains(this.domNode.ownerDocument.activeElement)
			? this.domNode.ownerDocument.activeElement as HTMLElement : undefined;
		const position = this.configurationService.getValue<ActivityBarPosition>(WorkbenchConfiguration.activityBarLocation);
		const separateRow = position === ActivityBarPosition.TOP || position === ActivityBarPosition.BOTTOM;
		const visible = position !== ActivityBarPosition.HIDDEN && !(separateRow
			&& this.configurationService.getValue<boolean>(WorkbenchConfiguration.activityBarAutoHide)
			&& this.visibleViewContainersTracker.visibleCount <= 1);
		const active = this.activeCompositeId ? this.getComposite(this.activeCompositeId) : undefined;
		this.activeTitle.textContent = active?.getTitle() ?? '';
		// Custom view headers and the container selector share this Part-owned title slot.
		const content: HTMLElement[] = [];
		if (!separateRow && visible) {
			content.push(this.compositeBar.domNode);
		}
		if (projection?.content) {
			content.push(projection.content);
		} else if (separateRow || !visible) {
			content.push(this.activeTitle);
		}
		if (content.length !== this.titleHost.childNodes.length || content.some((node, index) => node !== this.titleHost.childNodes[index])) {
			this.titleHost.replaceChildren(...content);
		}
		if (separateRow) {
			if (position === ActivityBarPosition.TOP) {
				if (this.selectorHost.nextSibling !== this.titleDomNode) {
					this.domNode.insertBefore(this.selectorHost, this.titleDomNode);
				}
			} else if (this.domNode.lastChild !== this.selectorHost) {
				this.domNode.append(this.selectorHost);
			}
			if (this.compositeBar.domNode.parentElement !== this.selectorHost) {
				this.selectorHost.append(this.compositeBar.domNode);
			}
		}
		this.selectorHost.hidden = !separateRow || !visible;
		super.setTitleProjection({ content: this.titleHost, actions: projection?.actions });
		this.setCompositeBarVisible(visible);
		this.layout(new Dimension(this.domNode.clientWidth, this.domNode.clientHeight));
		if (focused) {
			if (visible) {
				focused.focus();
			} else if (active?.panes.length) {
				active.focus();
			} else {
				this.domNode.tabIndex = -1;
				this.domNode.focus();
			}
		}
	}
}
