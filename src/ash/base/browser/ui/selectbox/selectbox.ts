import { Emitter } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { Lxicon } from '../../../common/lxicons.js';
import { addDisposableListener, isHTMLElement, stopEvent, h } from '../../dom.js';
import { focusPreservingScroll } from '../../focus.js';
import { isModifierKey } from '../../keyboardEvent.js';
import { setAriaAttribute, setRole } from '../aria/aria.js';
import { AnchorAlignment, type IContextViewProvider } from '../contextview/contextview.js';
import { Dropdown } from '../dropdown/dropdown.js';
import { List } from '../list/listWidget.js';
import { appendIcon } from '../lxicons/lxicon.js';

export interface SelectOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly disabled?: boolean;
}

/** Host-provided CSS colors, resolved through the containing theme root. */
export interface ISelectBoxStyles {
	readonly selectBackground: string | undefined;
	readonly selectForeground: string | undefined;
	readonly selectBorder: string | undefined;
	readonly selectListBackground: string | undefined;
	readonly focusBorder: string | undefined;
}

export interface SelectBoxOptions {
	readonly options: readonly SelectOption[];
	readonly selectedValue?: string;
	readonly ariaLabel?: string;
	readonly presentation?: SelectBoxPresentation;
	readonly contextViewProvider?: IContextViewProvider;
}

/** Visual treatment for the select trigger while retaining the same behavior. */
export type SelectBoxPresentation = 'default' | 'field';

export interface SelectBoxSelection {
	readonly value: string;
	readonly index: number;
	readonly option: SelectOption;
}

/** A keyboard-accessible custom select backed by an anchored Dropdown. */
export class SelectBox extends Disposable {
	readonly element: HTMLDivElement;
	private readonly dropdown: Dropdown;
	private readonly list: HTMLDivElement;
	private readonly optionList: List<SelectOption>;
	private readonly _onDidSelect = this._register(new Emitter<SelectBoxSelection>());
	readonly onDidSelect = this._onDidSelect.event;
	private _enabled = true;

	constructor(container: HTMLElement, options: SelectBoxOptions, styles?: ISelectBoxStyles) {
		super();
		const ownerDocument = container.ownerDocument;
		// List owns row identity, logical focus and selection; SelectBox owns committing a value.
		this.optionList = this._register(new List<SelectOption>(h(ownerDocument, 'div'), {
			mouseSupport: false,
			getId: option => option.value,
			renderItem: (option, _index, row) => this.renderOption(option, row),
		}));
		const list = this.optionList.element;
		this.list = list;
		list.classList.add('ash-select-box-list');
		list.tabIndex = -1;

		const dropdown = this._register(new Dropdown(container, {
			label: '',
			content: list,
			ariaLabel: options.ariaLabel,
			gap: 2,
			anchorAlignment: AnchorAlignment.Right,
			contentWidth: 'at-least-trigger',
			contextViewProvider: options.contextViewProvider,
		}));
		this.dropdown = dropdown;
		this.element = dropdown.element;
		const presentation = options.presentation ?? 'default';
		this.element.classList.add('ash-select-box', `ash-select-box-${presentation}`);
		if (styles) {
			const colors = {
				'--ash-select-style-select-background': styles.selectBackground,
				'--ash-select-style-select-foreground': styles.selectForeground,
				'--ash-select-style-select-border': styles.selectBorder,
				'--ash-select-style-focus-border': styles.focusBorder,
			};
			for (const [property, value] of Object.entries(colors)) {
				if (value !== undefined) {
					this.element.style.setProperty(property, value);
					if (property !== '--ash-select-style-select-background') list.style.setProperty(property, value);
				}
			}
			const background = styles.selectListBackground;
			if (background !== undefined) {
				list.style.setProperty('--ash-select-style-select-list-background', background);
			}
		}
		dropdown.button.classList.add('ash-select-box-button');
		setRole(dropdown.button, 'combobox');
		setAriaAttribute(dropdown.button, 'haspopup', 'listbox');
		setAriaAttribute(dropdown.button, 'controls', list.id);
		setAriaAttribute(dropdown.button, 'autocomplete', 'none');

		this._register(dropdown.onDidChangeVisibility(({ visible }) => {
			this.setActiveIndex(this.selectedIndex);
			if (visible) {
				list.classList.toggle('pointer-navigation', !dropdown.button.matches(':focus-visible'));
				this.focusActiveOption();
			}
		}));
		this._register(addDisposableListener(list, 'click', (event) => {
			const index = this.optionIndexFromTarget(event.target);
			if (index === undefined) return;
			this.commitSelection(index);
		}));
		this._register(addDisposableListener(list, 'pointermove', (event) => {
			list.classList.add('pointer-navigation');
			const index = this.optionIndexFromTarget(event.target);
			if (index === undefined || this.options[index]?.disabled) return;
			this.setActiveIndex(index);
		}));
		this._register(addDisposableListener(list, 'keydown', (event) => {
			this.onListKeyDown(event);
		}));
		this._register(addDisposableListener(dropdown.button, 'keydown', (event) => {
			if (!event.isComposing && !isModifierKey(event)) list.classList.remove('pointer-navigation');
			if (event.key === 'Home' || event.key === 'End') {
				stopEvent(event);
				dropdown.show();
				this.moveActive(event.key === 'Home' ? 'first' : 'last');
			}
		}));

		this.setOptions(options.options);
		if (options.selectedValue !== undefined) {
			this.value = options.selectedValue;
		}
	}

	get options(): readonly SelectOption[] {
		return this.optionList.items;
	}

	get selectedIndex(): number {
		const selected = this.optionList.selection[0];
		return selected === undefined ? -1 : this.options.indexOf(selected);
	}

	get value(): string | undefined {
		return this.optionList.selection[0]?.value;
	}

	set value(value: string | undefined) {
		if (value === undefined) {
			this.applySelection(-1);
			return;
		}
		const index = this.options.findIndex((option) =>
			option.value === value
		);
		if (index < 0) {
			throw new RangeError(`Unknown select option '${value}'`);
		}
		if (this.options[index]?.disabled) {
			throw new RangeError(`Select option '${value}' is disabled`);
		}
		this.applySelection(index);
	}

	get enabled(): boolean {
		return this._enabled;
	}

	set enabled(value: boolean) {
		this._enabled = value;
		this.syncEnabledState();
	}

	setOptions(options: readonly SelectOption[]): void {
		validateOptions(options);
		const previousValue = this.value;
		this.optionList.items = options;
		const preservedIndex = previousValue === undefined
			? -1
			: this.options.findIndex((option) =>
				option.value === previousValue && !option.disabled
			);
		this.applySelection(
			preservedIndex >= 0 ? preservedIndex : this.firstEnabledIndex(),
		);
		this.syncEnabledState();
	}

	focus(): void {
		this.dropdown.focus();
	}

	setAriaLabel(label: string): void {
		setAriaAttribute(this.dropdown.button, 'label', label);
	}

	blur(): void {
		this.dropdown.button.blur();
	}

	show(): void {
		this.dropdown.show();
	}

	hide(): void {
		this.dropdown.hide();
	}

	private renderOption(option: SelectOption, row: HTMLDivElement): HTMLElement {
		const ownerDocument = this.list.ownerDocument;
		row.classList.add('ash-select-box-option');
		row.tabIndex = -1;
		setAriaAttribute(row, 'disabled', option.disabled ? true : undefined);
		if (option.disabled) {
			row.classList.add('ash-select-box-option-disabled');
		}
		const element = h(ownerDocument, 'div');
		element.className = 'ash-select-box-option-content';
		const label = h(ownerDocument, 'span');
		label.className = 'ash-select-box-option-label';
		label.textContent = option.label;
		element.append(label);
		if (option.description) {
			const description = h(ownerDocument, 'span');
			description.className = 'ash-select-box-option-description';
			description.textContent = option.description;
			element.append(description);
		}
		const check = h(ownerDocument, 'span');
		check.className = 'ash-select-box-option-check';
		setAriaAttribute(check, 'hidden', true);
		appendIcon(Lxicon.check, check);
		element.append(check);
		return element;
	}

	private applySelection(index: number): void {
		this.optionList.setSelection(index < 0 ? [] : [index]);
		this.setActiveIndex(index);
		const option = this.options[index];
		this.dropdown.setLabel(option?.label ?? '');
		this.dropdown.button.title = option?.label ?? '';
		for (const [optionIndex, element] of this.optionElements().entries()) {
			const selected = optionIndex === index;
			element.classList.toggle('ash-select-box-option-selected', selected);
		}
	}

	private commitSelection(index: number): void {
		const option = this.options[index];
		if (!option || option.disabled) return;
		const changed = index !== this.selectedIndex;
		this.applySelection(index);
		this.dropdown.hide();
		if (!changed) return;
		this._onDidSelect.fire({
			value: option.value,
			index,
			option,
		});
	}

	private onListKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || isModifierKey(event)) return;
		this.list.classList.remove('pointer-navigation');
		switch (event.key) {
			case 'ArrowDown':
				stopEvent(event);
				this.moveActive('next');
				break;
			case 'ArrowUp':
				stopEvent(event);
				this.moveActive('previous');
				break;
			case 'Home':
				stopEvent(event);
				this.moveActive('first');
				break;
			case 'End':
				stopEvent(event);
				this.moveActive('last');
				break;
			case 'Enter':
			case ' ':
				stopEvent(event);
				this.commitSelection(this.optionList.activeIndex);
				break;
			case 'Tab':
				this.dropdown.hide();
				break;
			default:
				if (
					!event.isComposing &&
					event.key.length === 1 &&
					!event.altKey &&
					!event.ctrlKey &&
					!event.metaKey
				) {
					this.moveActiveByPrefix(event.key);
				}
		}
	}

	private moveActiveByPrefix(prefix: string): void {
		const normalized = prefix.toLocaleLowerCase();
		const start = Math.max(0, this.optionList.activeIndex + 1);
		for (let offset = 0; offset < this.options.length; offset += 1) {
			const index = (start + offset) % this.options.length;
			const option = this.options[index];
			if (
				option &&
				!option.disabled &&
				option.label.toLocaleLowerCase().startsWith(normalized)
			) {
				this.setActiveIndex(index);
				this.focusActiveOption();
				return;
			}
		}
	}

	private moveActive(
		direction: 'next' | 'previous' | 'first' | 'last',
	): void {
		if (this.options.length === 0) return;
		let index: number;
		let step: number;
		if (direction === 'first') {
			index = 0;
			step = 1;
		} else if (direction === 'last') {
			index = this.options.length - 1;
			step = -1;
		} else {
			step = direction === 'next' ? 1 : -1;
			index = this.optionList.activeIndex < 0
				? (step > 0 ? 0 : this.options.length - 1)
				: this.optionList.activeIndex + step;
		}
		while (index >= 0 && index < this.options.length) {
			if (!this.options[index]?.disabled) {
				this.setActiveIndex(index);
				this.focusActiveOption();
				return;
			}
			index += step;
		}
	}

	private setActiveIndex(index: number): void {
		this.optionList.setActiveIndex(index, undefined, { reveal: false });
		// A collapsed ContextView detaches its options; ARIA must never reference them.
		if (index < 0 || !this.dropdown.visible) {
			setAriaAttribute(
				this.dropdown.button,
				'activedescendant',
				undefined,
			);
		} else {
			setAriaAttribute(
				this.dropdown.button,
				'activedescendant',
				this.optionList.row(index)?.id,
			);
		}
		for (const [optionIndex, element] of this.optionElements().entries()) {
			element.classList.toggle(
				'ash-select-box-option-active',
				optionIndex === index,
			);
		}
	}

	private focusActiveOption(): void {
		const option = this.optionList.row(this.optionList.activeIndex);
		if (option) focusPreservingScroll(option);
		option?.scrollIntoView({
			block: 'nearest',
		});
	}

	private optionElements(): HTMLElement[] {
		return Array.from(
			this.list.querySelectorAll<HTMLElement>(
				'.ash-select-box-option',
			),
		);
	}

	private optionIndexFromTarget(target: EventTarget | null): number | undefined {
		if (!isHTMLElement(target)) return undefined;
		const option = target.closest<HTMLElement>('.ash-select-box-option');
		if (!option || !this.list.contains(option)) return undefined;
		const index = Number.parseInt(option.dataset.index ?? '', 10);
		return Number.isInteger(index) ? index : undefined;
	}

	private firstEnabledIndex(): number {
		return this.options.findIndex((option) => !option.disabled);
	}

	private syncEnabledState(): void {
		this.dropdown.enabled = this._enabled && this.firstEnabledIndex() >= 0;
	}
}

function validateOptions(options: readonly SelectOption[]): void {
	const values = new Set<string>();
	for (const option of options) {
		if (values.has(option.value)) {
			throw new TypeError(`Duplicate select option value '${option.value}'`);
		}
		values.add(option.value);
	}
}
