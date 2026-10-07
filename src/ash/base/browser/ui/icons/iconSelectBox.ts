import './iconSelectBox.css';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../dom.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import type { ThemeIcon } from '../../../common/themables.js';
import { setAriaAttribute } from '../aria/aria.js';
import { InputBox } from '../inputbox/inputbox.js';
import { appendIcon } from '../lxicons/lxicon.js';
import { ScrollableElement } from '../scrollbar/scrollableElement.js';

export interface IIconSelectBoxOptions {
	readonly icons: readonly ThemeIcon[];
	readonly showIconInfo?: boolean;
}

interface RenderedIcon {
	readonly icon: ThemeIcon;
	readonly element: HTMLElement;
}

let nextIconSelectBoxId = 0;

/** A searchable SVG icon grid with one keyboard focus target. */
export class IconSelectBox extends Disposable {
	public readonly domId = `ash-icon-select-box-${++nextIconSelectBoxId}`;
	public readonly domNode: HTMLElement;
	private readonly onDidSelectEmitter = this._register(new Emitter<ThemeIcon>());
	public readonly onDidSelect = this.onDidSelectEmitter.event;
	protected readonly inputBox: InputBox;
	private readonly scrollable: ScrollableElement;
	private readonly grid: HTMLElement;
	private readonly iconInfo: HTMLElement | undefined;
	private readonly icons: readonly ThemeIcon[];
	private renderedIcons: RenderedIcon[] = [];
	private focusedItemIndex = -1;
	private numberOfElementsPerRow = 1;
	private selectedIconId: string | undefined;

	constructor(options: IIconSelectBoxOptions, ownerDocument: Document = document) {
		super();
		this.icons = options.icons;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'ash-icon-select-box';
		this._register(toDisposable(() => this.domNode.remove()));

		const inputContainer = h(ownerDocument, 'div');
		inputContainer.className = 'ash-icon-select-input';
		this.domNode.append(inputContainer);
		this.inputBox = this._register(new InputBox(inputContainer, {
			placeholder: localize('iconSelect.placeholder', 'Search icons'),
			ariaLabel: localize('iconSelect.search', 'Search icons'),
			role: 'combobox',
			ariaAutoComplete: 'list',
			ariaControls: `${this.domId}-icons`,
			ariaExpanded: true,
			presentation: 'field',
		}));
		const help = h(ownerDocument, 'span');
		help.id = `${this.domId}-help`;
		help.className = 'ash-icon-select-help';
		help.textContent = localize('iconSelect.help', 'Use arrow keys to browse icons and Enter to select.');
		inputContainer.append(help);
		setAriaAttribute(this.inputBox.inputElement, 'describedby', help.id);

		this.scrollable = this._register(new ScrollableElement(this.domNode, { direction: 'vertical', tabIndex: -1 }));
		this.scrollable.element.classList.add('ash-icon-select-scroll');
		this.grid = h(ownerDocument, 'div');
		this.grid.id = `${this.domId}-icons`;
		this.grid.className = 'ash-icon-select-grid';
		this.grid.setAttribute('role', 'listbox');
		this.grid.setAttribute('aria-label', localize('iconSelect.icons', 'Icons'));
		this.scrollable.contentElement.append(this.grid);

		if (options.showIconInfo) {
			this.iconInfo = h(ownerDocument, 'div');
			this.iconInfo.className = 'ash-icon-select-info';
			this.domNode.append(this.iconInfo);
		}

		this._register(this.inputBox.onDidChange(value => this.renderIcons(value)));
		this._register(this.inputBox.onKeyDown(event => this.handleKeyDown(event)));
		this._register(addDisposableListener(this.grid, 'click', event => {
			const item = (event.target as Element).closest<HTMLElement>('.ash-icon-select-item');
			if (!item || !this.grid.contains(item)) return;
			this.setSelection(Number(item.dataset.index));
		}));
		this.renderIcons('');
	}

	public layout(dimension: IDimension): void {
		this.domNode.style.width = `${dimension.width}px`;
		this.domNode.style.height = `${dimension.height}px`;
		this.numberOfElementsPerRow = Math.max(1, Math.floor((dimension.width - 24) / 40));
		this.grid.style.gridTemplateColumns = `repeat(${this.numberOfElementsPerRow}, 36px)`;
		this.scrollable.layout();
	}

	public getFocus(): number[] { return this.focusedItemIndex < 0 ? [] : [this.focusedItemIndex]; }

	public setSelection(index: number): void {
		if (!Number.isInteger(index) || index < 0 || index >= this.renderedIcons.length) throw new RangeError(`Invalid icon index ${index}`);
		this.focusIcon(index);
		const icon = this.renderedIcons[index]!.icon;
		this.selectedIconId = icon.id;
		for (const item of this.renderedIcons) setAriaAttribute(item.element, 'selected', item.icon.id === icon.id);
		this.onDidSelectEmitter.fire(icon);
	}

	public clearInput(): void { this.inputBox.value = ''; }
	public focus(): void { this.inputBox.focus(); }
	public focusNext(): void { this.moveFocus(1); }
	public focusPrevious(): void { this.moveFocus(-1); }
	public focusNextRow(): void { this.moveFocus(this.numberOfElementsPerRow); }
	public focusPreviousRow(): void { this.moveFocus(-this.numberOfElementsPerRow); }

	public getFocusedIcon(): ThemeIcon {
		const icon = this.renderedIcons[this.focusedItemIndex]?.icon;
		if (!icon) throw new RangeError('No icon is focused');
		return icon;
	}

	private renderIcons(query: string): void {
		const previousId = this.renderedIcons[this.focusedItemIndex]?.icon.id;
		const needle = query.trim().toLowerCase();
		const icons = this.icons.filter(icon => icon.id.toLowerCase().includes(needle));
		const ownerDocument = this.domNode.ownerDocument;
		const fragment = ownerDocument.createDocumentFragment();
		this.renderedIcons = icons.map((icon, index) => {
			const element = h(ownerDocument, 'div');
			element.className = 'ash-icon-select-item';
			element.id = `${this.domId}-icon-${index}`;
			element.dataset.index = String(index);
			element.setAttribute('role', 'option');
			element.setAttribute('aria-label', icon.id);
			setAriaAttribute(element, 'selected', icon.id === this.selectedIconId);
			element.title = icon.id;
			appendIcon(icon, element);
			fragment.append(element);
			return { icon, element };
		});
		if (icons.length === 0) {
			const message = h(ownerDocument, 'div');
			message.className = 'ash-icon-select-empty';
			message.setAttribute('role', 'status');
			message.textContent = localize('iconSelect.noResults', 'No icons found');
			fragment.append(message);
		}
		this.grid.replaceChildren(fragment);
		const index = icons.findIndex(icon => icon.id === previousId);
		this.focusIcon(index >= 0 ? index : icons.length > 0 ? 0 : -1);
		this.scrollable.layout();
	}

	private focusIcon(index: number): void {
		this.renderedIcons[this.focusedItemIndex]?.element.classList.remove('focused');
		this.focusedItemIndex = index;
		const item = this.renderedIcons[index];
		if (!item) {
			this.inputBox.ariaActiveDescendant = undefined;
			this.renderIconInfo(undefined);
			return;
		}
		item.element.classList.add('focused');
		this.inputBox.ariaActiveDescendant = item.element.id;
		this.renderIconInfo(item.icon.id);
		this.scrollable.reveal(item.element);
	}

	private renderIconInfo(iconId: string | undefined): void {
		if (!this.iconInfo) return;
		if (!iconId) {
			this.iconInfo.replaceChildren();
			return;
		}
		const query = this.inputBox.value.trim();
		const match = iconId.toLowerCase().indexOf(query.toLowerCase());
		if (!query || match < 0) {
			this.iconInfo.textContent = iconId;
			return;
		}
		const highlight = h(this.domNode.ownerDocument, 'mark');
		highlight.textContent = iconId.slice(match, match + query.length);
		this.iconInfo.replaceChildren(iconId.slice(0, match), highlight, iconId.slice(match + query.length));
	}

	private moveFocus(delta: number): void {
		if (this.renderedIcons.length === 0) return;
		const count = this.renderedIcons.length;
		const index = ((this.focusedItemIndex + delta) % count + count) % count;
		this.focusIcon(index);
	}

	private handleKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowRight': this.focusNext(); break;
			case 'ArrowLeft': this.focusPrevious(); break;
			case 'ArrowDown': this.focusNextRow(); break;
			case 'ArrowUp': this.focusPreviousRow(); break;
			case 'Home': this.focusIcon(this.renderedIcons.length > 0 ? 0 : -1); break;
			case 'End': this.focusIcon(this.renderedIcons.length - 1); break;
			case 'Enter':
				if (this.focusedItemIndex >= 0) this.setSelection(this.focusedItemIndex);
				break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
	}
}
