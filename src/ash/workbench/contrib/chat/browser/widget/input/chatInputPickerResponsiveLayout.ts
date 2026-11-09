import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';

// Preserve a readable model name in toolbars that only compact the mode picker.
const minimumReadableModelWidth = 48;

export interface IChatInputPickerResponsiveLayoutItem {
	setCompact(compact: boolean): void;
}

/** Keeps the chat input pickers readable as their toolbar changes width. */
export class ChatInputPickerResponsiveLayout extends Disposable {
	private readonly relayout = this._register(new RunOnceScheduler(() => this.layout(), 0));
	private readonly resizeObserver: ResizeObserver;
	private footer: {
		readonly element: HTMLElement;
		readonly getGroups: () => readonly (readonly IChatInputPickerResponsiveLayoutItem[])[];
		readonly isEnabled: () => boolean;
	} | undefined;

	constructor(private readonly toolbar: HTMLElement) {
		super();
		this.resizeObserver = new ResizeObserver(() => this.relayout.schedule());
		this.resizeObserver.observe(toolbar);
		this._register(toDisposable(() => this.resizeObserver.disconnect()));
	}

	public setFooter(element: HTMLElement, getGroups: () => readonly (readonly IChatInputPickerResponsiveLayoutItem[])[], isEnabled: () => boolean): void {
		this.footer = { element, getGroups, isEnabled };
		this.toolbar.querySelector('.ash-chat-input-mode-selector.compact')?.classList.remove('compact');
		this.resizeObserver.unobserve(this.toolbar);
		this.resizeObserver.observe(element);
		// Labels and visibility can change while the footer retains the same width.
		const observer = new element.ownerDocument.defaultView!.MutationObserver(() => this.relayout.schedule());
		observer.observe(element, { subtree: true, childList: true, characterData: true, attributeFilter: ['hidden'] });
		this._register(toDisposable(() => observer.disconnect()));
		this.relayout.schedule();
	}

	public layout(): void {
		if (this.footer) {
			this.layoutFooter(this.footer);
			return;
		}
		if (!this.toolbar.isConnected || this.toolbar.clientWidth === 0) return;
		const modeSelector = this.toolbar.querySelector<HTMLElement>('.ash-chat-input-mode-selector');
		const modelSelector = this.toolbar.querySelector<HTMLElement>('.ash-chat-input-model-selector');
		if (!modeSelector || !modelSelector) return;
		modeSelector.classList.remove('compact');
		modelSelector.style.flexShrink = '0';
		const preferredModelWidth = modelSelector.getBoundingClientRect().width;
		modelSelector.style.removeProperty('flex-shrink');
		const availableModelWidth = modelSelector.getBoundingClientRect().width;
		modeSelector.classList.toggle('compact', availableModelWidth + 1 < Math.min(preferredModelWidth, minimumReadableModelWidth));
	}

	private layoutFooter({ element, getGroups, isEnabled }: NonNullable<ChatInputPickerResponsiveLayout['footer']>): void {
		if (!element.isConnected || element.clientWidth === 0) return;
		const groups = getGroups();
		for (const group of groups) {
			for (const item of group) item.setCompact(false);
		}
		if (!isEnabled()) return;
		// Measure the pickers at their intrinsic widths so flex shrink cannot hide overflow.
		element.classList.add('ash-chat-input-footer-measuring');
		try {
			for (const group of groups) {
				if (element.scrollWidth <= element.clientWidth) break;
				for (const item of group) item.setCompact(true);
			}
		} finally {
			element.classList.remove('ash-chat-input-footer-measuring');
		}
	}
}
