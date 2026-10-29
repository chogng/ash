import './segmentedControl.css';
import { addDisposableListener, getWindow, h } from '../../dom.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import type { Icon } from '../../../common/icon.js';
import { getHoverDelegate, type IHoverDelegate } from '../hover/hoverDelegate.js';
import { appendIcon } from '../lxicons/lxicon.js';

export interface SegmentedControlItem<T extends string> {
	readonly id: T;
	/** Visible text and accessible name; callers provide localized product labels. */
	readonly label: string;
	readonly icon?: Icon;
	readonly disabled?: boolean;
}

export interface SegmentedControlOptions<T extends string> {
	readonly ariaLabel: string;
	readonly items: readonly SegmentedControlItem<T>[];
	readonly selectedId: T;
	readonly presentation?: 'label' | 'icon';
	readonly hoverDelegate?: IHoverDelegate;
	/** Requests activation, including reactivation of the current item. Does not commit selection. */
	readonly onActivate: (id: T) => void;
}

/**
 * A manually activated, single-selection toolbar with equal-width segments.
 * The caller owns selection and commits it with setSelection after activation succeeds.
 * Arrow keys move focus independently; Enter and Space activate the focused button.
 */
export class SegmentedControl<T extends string> extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly buttons: readonly HTMLButtonElement[];
	private readonly items: readonly SegmentedControlItem<T>[];

	constructor(container: HTMLElement, options: SegmentedControlOptions<T>) {
		const ids = new Set(options.items.map(item => item.id));
		const selectedIndex = options.items.findIndex(item => item.id === options.selectedId);
		if (options.items.length < 2 || ids.size !== options.items.length) {
			throw new TypeError('SegmentedControl requires at least two items with unique IDs');
		}
		if (selectedIndex < 0) throw new RangeError(`Selected segment is not available: ${options.selectedId}`);
		const presentation = options.presentation ?? 'label';
		if (presentation === 'icon' && options.items.some(item => !item.icon)) {
			throw new TypeError('Icon segments require an icon for every item');
		}
		super();
		this.items = options.items;
		const group = h(container.ownerDocument, 'div');
		this.domNode = group;
		group.className = `ash-segmented-control ash-segmented-control-${presentation}`;
		group.setAttribute('role', 'toolbar');
		group.setAttribute('aria-label', options.ariaLabel);
		group.setAttribute('aria-orientation', 'horizontal');
		group.style.setProperty('--ash-segmented-control-count', String(options.items.length));
		this._register(toDisposable(() => {
			for (const animation of group.getAnimations?.({ subtree: true }) ?? []) animation.cancel();
			group.remove();
		}));
		const hovers = options.hoverDelegate ?? getHoverDelegate();
		this.buttons = options.items.map(item => {
			const button = h(container.ownerDocument, 'button');
			button.className = 'ash-segmented-control-option';
			button.type = 'button';
			button.disabled = item.disabled === true;
			button.setAttribute('aria-label', item.label);
			if (item.icon) appendIcon(item.icon, button);
			if (presentation === 'label') {
				const label = h(container.ownerDocument, 'span');
				label.className = 'ash-segmented-control-label';
				label.textContent = item.label;
				button.append(label);
			}
			this._register(hovers.setupDelayedHover(button, { content: item.label }));
			this._register(addDisposableListener(button, 'click', () => {
				if (!button.disabled) options.onActivate(item.id);
			}));
			group.append(button);
			return button;
		});
		this.applySelection(selectedIndex);
		this._register(addDisposableListener(group, 'keydown', event => this.onKeyDown(event)));
		container.append(group);
	}

	/** Projects the owner's selection without requesting activation or moving focus. */
	setSelection(id: T): void {
		const index = this.items.findIndex(item => item.id === id);
		if (index < 0) throw new RangeError(`Selected segment is not available: ${id}`);
		this.applySelection(index);
	}

	private applySelection(index: number): void {
		const focusIndex = this.buttons[index]!.disabled ? this.buttons.findIndex(button => !button.disabled) : index;
		this.buttons.forEach((button, i) => {
			const selected = i === index;
			button.classList.toggle('checked', selected);
			button.setAttribute('aria-pressed', String(selected));
			button.tabIndex = i === focusIndex ? 0 : -1;
		});
		// CSS uses segment count and index so resizing and RTL need no geometry observers.
		this.domNode.style.setProperty('--ash-segmented-control-selected-index', String(index));
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const index = this.buttons.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		const rtl = getWindow(this.domNode).getComputedStyle(this.domNode).direction === 'rtl';
		let next: number;
		switch (event.key) {
			case 'Home': next = this.buttons.findIndex(button => !button.disabled); break;
			case 'End':
				next = this.buttons.length - 1;
				while (next >= 0 && this.buttons[next]!.disabled) next--;
				break;
			case 'ArrowLeft': case 'ArrowRight': {
				const direction = (event.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
				next = index;
				for (let step = 1; step <= this.buttons.length; step++) {
					const candidate = (index + direction * step + this.buttons.length) % this.buttons.length;
					if (!this.buttons[candidate]!.disabled) { next = candidate; break; }
				}
				break;
			}
			default: return;
		}
		if (next < 0) return;
		event.preventDefault();
		event.stopPropagation();
		this.buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
		this.buttons[next]!.focus();
	}
}
