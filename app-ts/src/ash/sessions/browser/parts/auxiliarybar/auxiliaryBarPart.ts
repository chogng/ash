import "./media/auxiliaryBarPart.css";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AuxiliarybarPart } from '../../../../workbench/browser/parts/auxiliarybar/auxiliarybarPart.js';
import { PaneComposite } from '../../../../workbench/browser/parts/views/paneComposite.js';
import { IViewDescriptorService } from '../../../../workbench/services/views/common/viewDescriptorService.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';

/** Composes Sessions contributions in the shared retained Auxiliary Bar. */
export class AuxiliaryBarPart extends AuxiliarybarPart {

	override get minimumWidth(): number { return 180; }
	override get maximumWidth(): number { return 460; }

	constructor(
		container: HTMLElement,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IStorageService storage: IStorageService,
	) {
		super(container, { viewDescriptorService: descriptors, contextKeyService: contextKeys, storageService: storage });
		this.domNode.classList.add('ash-sessions-auxiliarybar');
		this.setCompositeBarVisible(true);
		this._register(this.onDidSelectComposite(event => this.showComposite(event.compositeId)));
	}

	public initialize(): void {
		for (const viewContainer of this.descriptors.getViewContainers(ViewContainerLocation.AuxiliaryBar)) {
			this.addComposite(new PaneComposite(this.domNode, {
				viewContainer,
				model: this.descriptors.getViewContainerModel(viewContainer.id),
				instantiationService: this.instantiation,
				contextKeyService: this.contextKeys,
				paneLayout: 'fill',
				paneHeaders: 'hidden',
				onDidFailCreateView: error => { throw error; },
			}));
		}
		const restored = this.getCompositeIdToRestore();
		if (restored) { this.showComposite(restored); }
	}
}
