import './documentFormattingControls.css';
import 'ash:editor/base/browser/ui/selectbox/selectbox.css';
import 'ash:editor/base/browser/ui/dropdown/dropdown.css';
import { addDisposableListener, h } from 'ash:editor/base/browser/dom.js';
import { Disposable, toDisposable } from 'ash:editor/base/common/lifecycle.js';
import { SelectBox, type SelectOption } from 'ash:editor/base/browser/ui/selectbox/selectbox.js';
import { Button } from 'ash:editor/base/browser/ui/button/button.js';
import { InputBox } from 'ash:editor/base/browser/ui/inputbox/inputbox.js';
import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultSelectBoxStyles,
} from 'ash:editor/platform/theme/browser/defaultStyles.js';

/** Shared control mechanics only; each contribution owns its choices, commands and derived state. */
export class DocumentFormattingControls extends Disposable {
	readonly element: HTMLDivElement;
	private readonly displayedValues = new WeakMap<SelectBox, string>();

	constructor(container: HTMLElement, label: string) {
		super();
		this.element = h(container.ownerDocument, 'div');
		this.element.className = 'stanza-document-format-controls';
		this.element.hidden = true;
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', label);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}

	addSelect(label: string, options: readonly SelectOption[], run: (value: string) => void): SelectBox {
		const wrapper = h(this.element.ownerDocument, 'div');
		wrapper.className = 'stanza-document-format-control';
		const text = h(this.element.ownerDocument, 'span');
		text.textContent = label;
		wrapper.append(text);
		this.element.append(wrapper);
		// Use the shared SelectBox for keyboard navigation, Escape/focus restoration
		// and theme/HC styling, rather than maintaining a second dropdown behavior.
		const select = this._register(new SelectBox(wrapper, { options, ariaLabel: label }, defaultSelectBoxStyles));
		this._register(
			select.onDidSelect(({ value }) => {
				if (!select.enabled) return;
				if (value !== '') run(value);
				// Mixed describes the selection; choosing it cannot clear document styles.
				else select.value = this.displayedValues.get(select) ?? '';
			}),
		);
		return select;
	}

	protected addButton(label: string, run: () => void): Button {
		const button = this._register(new Button(this.element, { ...defaultButtonStyles, label, size: 'small' }));
		this._register(
			button.onDidClick(() => {
				if (button.enabled) run();
			}),
		);
		return button;
	}

	protected addInput(label: string, type: 'text' | 'number' | 'search' = 'text'): InputBox {
		const wrapper = h(this.element.ownerDocument, 'label');
		wrapper.className = 'stanza-document-format-control';
		const text = h(this.element.ownerDocument, 'span');
		text.textContent = label;
		wrapper.append(text);
		this.element.append(wrapper);
		return this._register(new InputBox(wrapper, { ariaLabel: label, type, inputBoxStyles: defaultInputBoxStyles }));
	}

	protected onInputCommit(input: InputBox, run: (value: string) => void): void {
		this._register(
			addDisposableListener(input.inputElement, 'change', () => {
				if (input.enabled) run(input.value);
			}),
		);
	}

	protected setSelectValue(select: SelectBox, value: string): void {
		// The popup owns its provisional active option. Only a committed document
		// value change should update selection while keyboard navigation is pending.
		if (select.value !== value) select.value = value;
		this.displayedValues.set(select, value);
	}
}
