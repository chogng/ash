import { IActivityService } from '../../../../workbench/services/activity/common/activity.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/auxiliaryBarPart.css";
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { PaneCompositePart } from '../../../../workbench/browser/parts/paneCompositePart.js';
import '../../../../workbench/browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SESSION_AUXILIARYBAR_DEFAULT_WIDTH } from '../../../common/layoutConstants.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';

/** Hosts Code details and Design properties; editor tabs own their navigation. */
export class AuxiliaryBarPart extends PaneCompositePart {

	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 460; }
	override get preferredWidth(): number {
		const width = this.activeCompositeId ? this.getComposite(this.activeCompositeId)!.getOptimalWidth() : 0;
		return Math.max(SESSION_AUXILIARYBAR_DEFAULT_WIDTH, width);
	}

	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
		@IActivityService activityService: IActivityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
	) {
		super(container, {
			id: 'auxiliarybar',
			location: ViewContainerLocation.AuxiliaryBar,
			ariaLabel: 'Auxiliary sidebar',
			ariaLabelKey: { bundle: 'ash.regions', key: 'auxiliarySidebar' },
			viewsAriaLabel: 'Auxiliary sidebar views',
			viewsAriaLabelKey: { bundle: 'ash.regions', key: 'auxiliarySidebarViews' },
			compositeBarVisible: false,
			viewDescriptorService: descriptors, contextKeyService: contextKeys,
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
		}, themeService, storage, activityService);
		this.domNode.classList.add('ash-sessions-auxiliarybar');
		this.contentDomNode.classList.add('ash-auxiliarybar-content');
	}

	public override showComposite(compositeId: string, focus = false): void {
		super.showComposite(compositeId, focus);
		this.setTitleProjection(this.getComposite(compositeId)?.partTitleProjection);
	}
}
