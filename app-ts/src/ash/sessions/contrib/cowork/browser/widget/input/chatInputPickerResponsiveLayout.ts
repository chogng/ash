import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';

// The model picker has no compact icon, so keep part of its name visible before collapsing the mode label.
const minimumReadableModelWidth = 48;

/** Keeps the chat input pickers readable as their toolbar changes width. */
export class ChatInputPickerResponsiveLayout extends Disposable {
	constructor(private readonly toolbar: HTMLElement) {
		super();
		const resizeObserver = new ResizeObserver(() => this.layout());
		resizeObserver.observe(toolbar);
		this._register(toDisposable(() => resizeObserver.disconnect()));
	}

	public layout(): void {
		if (!this.toolbar.isConnected || this.toolbar.clientWidth === 0) return;
		const modeSelector = this.toolbar.querySelector<HTMLElement>('.ash-cowork-input-mode-selector');
		const modelSelector = this.toolbar.querySelector<HTMLElement>('.ash-cowork-input-model-selector');
		if (!modeSelector || !modelSelector) return;
		modeSelector.classList.remove('compact');
		modelSelector.style.flexShrink = '0';
		const preferredModelWidth = modelSelector.getBoundingClientRect().width;
		modelSelector.style.removeProperty('flex-shrink');
		const availableModelWidth = modelSelector.getBoundingClientRect().width;
		modeSelector.classList.toggle('compact', availableModelWidth + 1 < Math.min(preferredModelWidth, minimumReadableModelWidth));
	}
}
