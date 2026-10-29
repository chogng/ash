import './media/chatInputPicker.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { AnchorPosition } from '../../../../../../base/browser/ui/contextview/contextview.js';
import type { IActionWidgetDropdownOptions } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';

/** Creates the input picker's two triggers; the caller owns activation and disposal. */
export function renderChatInputPickerSplit(container: HTMLElement, primaryButton: HTMLElement = h(container.ownerDocument, 'a'), secondaryButton: HTMLElement = h(container.ownerDocument, 'a')): { primaryButton: HTMLElement; secondaryButton: HTMLElement; } {
	container.classList.add('ash-chat-input-picker-split');
	container.setAttribute('role', 'group');
	container.tabIndex = -1;
	container.removeAttribute('aria-haspopup');
	container.removeAttribute('aria-expanded');
	const disabled = container.getAttribute('aria-disabled') === 'true';
	for (const button of [primaryButton, secondaryButton]) {
		button.classList.add('ash-chat-input-picker-button');
		button.setAttribute('role', 'button');
		button.setAttribute('aria-disabled', String(disabled));
		if (!button.hasAttribute('aria-haspopup')) { button.setAttribute('aria-haspopup', 'true'); }
		if (!button.hasAttribute('aria-expanded')) { button.setAttribute('aria-expanded', 'false'); }
		button.tabIndex = disabled ? -1 : 0;
		if (!button.querySelector('.ash-chat-input-picker-label')) {
			const label = h(container.ownerDocument, 'span');
			label.className = 'ash-chat-input-picker-label';
			button.append(label);
		}
	}
	if (primaryButton.parentElement !== container || secondaryButton.parentElement !== container) {
		container.replaceChildren(primaryButton, secondaryButton);
	}
	return { primaryButton, secondaryButton };
}

/** Popup focus restoration inherits focus-visible from inputs; track actual pointer and keyboard intent. */
export function trackChatInputPickerFocus(container: HTMLElement): IDisposable {
	const resources = new DisposableStore();
	const window = getWindow(container);
	container.classList.add('ash-chat-input-picker-focus-scope');
	resources.add(toDisposable(() => container.classList.remove('ash-chat-input-picker-focus-scope', 'pointer-focus')));
	resources.add(addDisposableListener(window, 'pointerdown', () => container.classList.add('pointer-focus'), true));
	resources.add(addDisposableListener(window, 'keydown', () => container.classList.remove('pointer-focus'), true));
	return resources;
}

/** Chat menus open above their trigger and remain separate Tab stops within a toolbar. */
export abstract class ChatInputPickerActionViewItem extends ActionWidgetDropdownActionViewItem {
	private externalAnchor: HTMLElement | undefined;

	constructor(action: IAction, options: Omit<IActionWidgetDropdownOptions, 'label' | 'ariaLabel' | 'labelRenderer'>, @IInstantiationService instantiationService: IInstantiationService) {
		super(action, { ...options, getAnchor: () => this.getAnchorElement(), listOptions: { ...options.listOptions, anchorPosition: AnchorPosition.Above } }, instantiationService);
	}

	protected getAnchorElement(): HTMLElement {
		return this.externalAnchor ?? this.element;
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this._register(trackChatInputPickerFocus(container));
	}

	public override show(anchor?: HTMLElement): void {
		this.externalAnchor = anchor;
		super.show();
	}

	public override setTabbable(_tabbable: boolean): void {
		this.element.tabIndex = this.action.enabled ? 0 : -1;
	}
}
