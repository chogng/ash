import './simpleFindWidget.css';
import { addDisposableListener, h, stopEvent } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

interface IFindOptions {
	readonly label: string;
	readonly placeholder: string;
	readonly previousLabel: string;
	readonly nextLabel: string;
	readonly closeLabel: string;
	onInput(value: string): void;
	onNavigate(previous: boolean): void;
	onClose(): void;
}

/** Presents find controls while the host owns the query, matches, and search scope. */
export class SimpleFindWidget extends Disposable {
	public readonly optionsElement: HTMLElement;
	private readonly element: HTMLElement;
	private readonly input: InputBox;
	private readonly status: HTMLElement;
	private readonly previousButton: Button;
	private readonly nextButton: Button;
	private composing = false;

	constructor(container: HTMLElement, options: IFindOptions) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-simple-find' });
		this.element.hidden = true;
		this.element.setAttribute('role', 'search');
		this.element.setAttribute('aria-label', options.label);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const row = h(document, 'div', { className: 'ash-simple-find-row' });
		const query = h(document, 'div', { className: 'ash-simple-find-query' });
		const actions = h(document, 'div', { className: 'ash-simple-find-actions' });
		this.status = h(document, 'span', { className: 'ash-simple-find-status' });
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.element.append(row);
		row.append(query, this.status, actions);

		this.input = this._register(new InputBox(query, {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'compact',
			ariaLabel: options.placeholder,
			placeholder: options.placeholder,
		}));
		this.optionsElement = h(document, 'div', { className: 'ash-simple-find-options' });
		query.append(this.optionsElement);
		this.previousButton = this._register(new Button(actions, {
			...defaultButtonStyles, size: 'small', iconOnly: true, icon: Lxicon.chevronUp,
			label: options.previousLabel, title: options.previousLabel, enabled: false,
			onClick: () => options.onNavigate(true),
		}));
		this.nextButton = this._register(new Button(actions, {
			...defaultButtonStyles, size: 'small', iconOnly: true, icon: Lxicon.chevronDown,
			label: options.nextLabel, title: options.nextLabel, enabled: false,
			onClick: () => options.onNavigate(false),
		}));
		this._register(new Button(actions, {
			...defaultButtonStyles, size: 'small', iconOnly: true, icon: Lxicon.close,
			label: options.closeLabel, title: options.closeLabel, onClick: () => options.onClose(),
		}));

		const input = this.input.inputElement;
		this._register(addDisposableListener(input, 'compositionstart', () => { this.composing = true; }));
		this._register(addDisposableListener(input, 'compositionend', () => {
			if (!this.composing) { return; }
			this.composing = false;
			options.onInput(this.inputValue);
		}));
		this._register(addDisposableListener<InputEvent>(input, 'input', event => {
			if (!this.composing && !event.isComposing) { options.onInput(this.inputValue); }
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (this.composing || event.isComposing || event.keyCode === 229) { return; }
			if (event.key === 'Escape') {
				stopEvent(event);
				options.onClose();
			} else if (event.key === 'Enter' && event.target === input) {
				stopEvent(event);
				options.onNavigate(event.shiftKey);
			}
		}));
	}

	public getDomNode(): HTMLElement { return this.element; }
	public getFindInputDomNode(): HTMLInputElement { return this.input.inputElement; }
	public get isComposing(): boolean { return this.composing; }
	public get inputValue(): string { return this.input.value; }
	public set inputValue(value: string) {
		this.composing = false;
		this.input.value = value;
	}

	public focusFindBox(): void {
		this.input.focus();
		this.input.select();
	}

	public setResult(message: string, options: { hasMatches: boolean; invalid: boolean; detail: boolean; }): void {
		this.previousButton.enabled = this.nextButton.enabled = options.hasMatches;
		this.getFindInputDomNode().setAttribute('aria-invalid', String(options.invalid));
		this.element.classList.toggle('invalid', options.invalid);
		this.status.classList.toggle('detail', options.detail);
		if (this.status.textContent !== message) { this.status.textContent = message; }
	}
}
