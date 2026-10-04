import "./media/auxiliaryBarPart.css";
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AuxiliarybarPart } from '../../../../workbench/browser/parts/auxiliarybar/auxiliarybarPart.js';
import { IViewDescriptorService } from '../../../../workbench/services/views/common/viewDescriptorService.js';

/** Hosts Code details and Design properties; editor tabs own their navigation. */
export class AuxiliaryBarPart extends AuxiliarybarPart {

	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 460; }

	constructor(
		container: HTMLElement,
		@IViewDescriptorService descriptors: IViewDescriptorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
	) {
		super(container, { viewDescriptorService: descriptors, contextKeyService: contextKeys, storageService: storage });
		this.domNode.classList.add('ash-sessions-auxiliarybar');
	}

}
