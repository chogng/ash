import { PaneComposite, type PaneCompositeOptions } from '../../../browser/parts/views/paneComposite.js';
import './media/scm.css';
import { IStorageService } from '../../../../platform/storage/common/storage.js';

export class SCMViewPaneContainer extends PaneComposite {
	constructor(container: HTMLElement, options: PaneCompositeOptions, @IStorageService storageService: IStorageService) {
		super(container, { ...options, mergeViewWithContainerWhenSingleView: true }, storageService);
		this.element.classList.add('ash-scm-viewlet');
	}

	override getOptimalWidth(): number {
		return 400;
	}
}
