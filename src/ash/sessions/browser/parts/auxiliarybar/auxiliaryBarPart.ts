import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/auxiliaryBarPart.css";
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AuxiliarybarPart } from '../../../../workbench/browser/parts/auxiliarybar/auxiliarybarPart.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { SESSION_AUXILIARYBAR_DEFAULT_WIDTH } from '../../../common/layoutConstants.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';

/** Hosts Code details and Design properties; editor tabs own their navigation. */
export class AuxiliaryBarPart extends AuxiliarybarPart {

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
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
	) {
		super(container, {
			viewDescriptorService: descriptors, contextKeyService: contextKeys,
			openComposite: (id, preserveFocus) => instantiationService.invokeFunction(accessor => accessor.get(IViewsService).openViewContainer(id, !preserveFocus)),
		}, themeService, storage);
		this.domNode.classList.add('ash-sessions-auxiliarybar');
	}

}
