import { h } from '../../../base/browser/dom.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IActivityService } from '../../../workbench/services/activity/common/activity.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import './media/auxiliaryBarPart.css';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { PaneCompositePart } from '../../../workbench/browser/parts/paneCompositePart.js';
import '../../../workbench/browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';

/** Hosts independently selected Code tools and Design properties. */
export class AuxiliaryBarPart extends PaneCompositePart {
	private readonly fallbackTitle: HTMLElement;
	private embedded = false;
	override get minimumWidth(): number {
		return this.embedded ? 180 : 270;
	}

	/** Docked Files actions are rendered by the editor header; product pages retain this Part title. */
	public setDocked(docked: boolean): void {
		if (this.embedded === docked) { return; }
		this.embedded = docked;
		this.titleDomNode.hidden = docked;
		this.notifyConstraintsChanged();
	}

	override get minimumHeight(): number {
		return this.embedded ? 120 : super.minimumHeight;
	}

	override get maximumWidth(): number {
		return Number.POSITIVE_INFINITY;
	}
	override get preferredWidth(): number {
		const width = this.activeCompositeId ? this.getComposite(this.activeCompositeId)!.getOptimalWidth() : 0;
		return Math.max(300, width);
	}

	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IActivityService activityService: IActivityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(
			container,
			{
				id: 'auxiliarybar',
				location: ViewContainerLocation.AuxiliaryBar,
				ariaLabel: 'Auxiliary sidebar',
				ariaLabelKey: { bundle: 'ash.regions', key: 'auxiliarySidebar' },
				viewsAriaLabel: 'Auxiliary sidebar views',
				viewsAriaLabelKey: { bundle: 'ash.regions', key: 'auxiliarySidebarViews' },
				compositeBarVisible: false,
				titleActions: {
					menuService: menus,
					contextMenuProvider: contextMenus,
					menuId: MenuId.AuxiliaryBarTitle,
				},
				viewDescriptorService: descriptors,
				contextKeyService: contextKeys,
				openComposite: (id, preserveFocus) =>
					instantiationService.invokeFunction(accessor =>
						accessor.get(IViewsService).openViewContainer(id, !preserveFocus),
					),
			},
			themeService,
			storage,
			activityService,
		);
		this.fallbackTitle = h(container.ownerDocument, 'span');
		this.fallbackTitle.className = 'ash-sessions-tool-title';
		this.domNode.classList.add('ash-sessions-auxiliarybar');
		this.contentDomNode.classList.add('ash-auxiliarybar-content');
	}

	public override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		const composite = this.getComposite(compositeId);
		const projection = composite?.partTitleProjection;
		this.fallbackTitle.textContent = composite?.title ?? '';
		this.setTitleProjection({ ...projection, content: projection?.content ?? this.fallbackTitle });
	}
}
