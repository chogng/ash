import type { HoverContent } from '../hover/hover.js';
import { getHoverDelegate, type IManagedHover } from '../hover/hoverDelegate.js';
import { Disposable, MutableDisposable } from '../../../common/lifecycle.js';
import { renderLabelWithIcons } from './iconLabels.js';

/** Lightweight icon-aware text label for controls that do not need descriptions. */
export class SimpleIconLabel extends Disposable {
	private readonly hover = this._register(new MutableDisposable<IManagedHover>());

	constructor(private readonly container: HTMLElement) {
		super();
	}

	set text(value: string) {
		renderLabelWithIcons(this.container, value ?? '');
	}

	set title(value: HoverContent) {
		this.hover.clear();
		this.container.removeAttribute('title');
		if (value === undefined || value === '') return;
		this.hover.value = getHoverDelegate().setupHover({ target: this.container, content: value });
	}
}
