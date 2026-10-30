import { addDisposableListener, h } from '../../../base/browser/dom.js';
import {
	ButtonActionViewItem,
	type ActionViewItemOptions,
} from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import type { IAction } from '../../../base/common/actions.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import './toolbarSearchActionViewItem.css';

/** Keeps an expandable search in its toolbar slot without consuming text-editing keys. */
export class ToolbarSearchActionViewItem extends ButtonActionViewItem {
	private field!: HTMLElement;
	private closeButton!: Button;
	private tabbable = false;

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly input: HTMLInputElement,
		private readonly closeSearch: () => void,
		private readonly closeLabel: string,
	) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-toolbar-search-action');
		this.field = h(container.ownerDocument, 'div', {
			className: 'ash-toolbar-search-field',
			properties: { hidden: true },
		});
		const icon = h(container.ownerDocument, 'span', { attributes: { 'aria-hidden': 'true' } });
		appendIcon(Lxicon.search, icon);
		this.input.classList.add('ash-toolbar-search-input');
		this.field.append(icon, this.input);
		this.closeButton = this.createButton(this.field, {
			label: this.closeLabel,
			icon: Lxicon.close,
			iconOnly: true,
			onClick: this.closeSearch,
		});
		container.append(this.field);
		this.setExpanded(false);
		this._register(
			addDisposableListener(this.field, 'focusout', event => {
				if (this.expanded && !this.input.value && !this.field.contains(event.relatedTarget as Node | null)) {
					// Collapse empty search without taking focus back from the user's next target.
					this.setExpanded(false);
				}
			}),
		);
		this._register(
			addDisposableListener(this.field, 'keydown', event => {
				if (event.key === 'Escape' && !event.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					this.closeSearch();
				} else if (
					event.target === this.input &&
					['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
				) {
					// The toolbar must not consume caret movement inside the search input.
					event.stopPropagation();
				}
			}),
		);
	}

	setExpanded(expanded: boolean): void {
		this.field.hidden = !expanded;
		// A closing field remains painted for its transition, but must stop accepting focus immediately.
		this.field.inert = !expanded;
		this.field.setAttribute('aria-hidden', String(!expanded));
		this.button.domNode.hidden = expanded;
		this.button.domNode.setAttribute('aria-expanded', String(expanded));
		this.field.parentElement!.classList.toggle('expanded', expanded);
		this.setTabbable(this.tabbable);
	}

	get expanded(): boolean {
		return !this.field.hidden;
	}

	override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		super.setTabbable(tabbable && !this.expanded);
		this.input.tabIndex = tabbable && this.expanded ? 0 : -1;
		this.closeButton.domNode.tabIndex = tabbable && this.expanded ? 0 : -1;
	}

	override focus(): void {
		if (this.expanded) {
			this.input.focus();
		} else {
			super.focus();
		}
	}
}
