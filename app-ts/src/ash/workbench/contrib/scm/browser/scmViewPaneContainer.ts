import { PaneComposite, type PaneCompositeOptions } from '../../../browser/parts/views/paneComposite.js';
import './media/scm.css';

export class SCMViewPaneContainer extends PaneComposite {
	constructor(container: HTMLElement, options: PaneCompositeOptions) {
		super(container, { ...options, mergeViewWithContainerWhenSingleView: true });
		this.element.classList.add('ash-scm-viewlet');
	}

	override getOptimalWidth(): number {
		return 400;
	}
}
