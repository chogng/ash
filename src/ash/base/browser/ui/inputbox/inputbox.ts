import './inputbox.css';
import { addDisposableListener, h } from "../../dom.js";
import type { IHistoryNavigationWidget } from '../../history.js';
import { DomEmitter, type DOMEventMap } from "../../event.js";
import {
	type AriaAutoComplete,
	type AriaRole,
	getAriaAttribute,
	setAriaAttribute,
	setRole,
} from "../aria/aria.js";
import { Emitter, type Event } from "../../../common/event.js";
import { HistoryNavigator, type IHistory } from '../../../common/history.js';
import { IME } from "../../../common/ime.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";

export interface InputBoxOptions {
	readonly placeholder?: string;
	readonly type?: "text" | "number" | "password" | "search";
	readonly presentation?: "default" | "field" | "compact";
	readonly readOnly?: boolean;
	readonly enabled?: boolean;
	readonly ariaLabel?: string;
	readonly role?: AriaRole;
	readonly ariaAutoComplete?: AriaAutoComplete;
	readonly ariaControls?: string;
	readonly ariaExpanded?: boolean;
}

export interface InputSelection {
	readonly start: number;
	readonly end: number;
}

/** A text input foundation with events, focus control, and validation state. */
export class InputBox extends Disposable {
	readonly element: HTMLDivElement;
	readonly inputElement: HTMLInputElement;
	private readonly message: HTMLDivElement;
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidFocus = this._register(new Emitter<void>());
	private readonly _onDidBlur = this._register(new Emitter<void>());
	private _readOnly: boolean;

	readonly onDidChange: Event<string> = this._onDidChange.event;
	readonly onDidFocus: Event<void> = this._onDidFocus.event;
	readonly onDidBlur: Event<void> = this._onDidBlur.event;
	readonly onKeyDown: Event<DOMEventMap["keydown"]>;

	constructor(container: HTMLElement, options: InputBoxOptions = {}) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-input-box";
		if (options.presentation === "field" || options.presentation === "compact") this.element.classList.add("ash-input-box-field");
		if (options.presentation === "compact") this.element.classList.add("ash-input-box-compact");
		this._register(toDisposable(() => this.element.remove()));

		this.inputElement = h(ownerDocument, "input");
		this.inputElement.type = options.type ?? "text";
		this.inputElement.placeholder = options.placeholder ?? "";
		this.inputElement.disabled = options.enabled === false;
		this.element.classList.toggle("is-disabled", this.inputElement.disabled);
		this.inputElement.autocomplete = "off";
		this.inputElement.autocapitalize = "off";
		this.inputElement.spellcheck = false;
		if (options.ariaLabel) {
			setAriaAttribute(this.inputElement, "label", options.ariaLabel);
		}
		setRole(this.inputElement, options.role);
		if (options.ariaAutoComplete) {
			setAriaAttribute(
				this.inputElement,
				"autocomplete",
				options.ariaAutoComplete,
			);
		}
		if (options.ariaControls) {
			setAriaAttribute(
				this.inputElement,
				"controls",
				options.ariaControls,
			);
		}
		if (options.ariaExpanded !== undefined) {
			setAriaAttribute(
				this.inputElement,
				"expanded",
				options.ariaExpanded,
			);
		}

		this._readOnly = options.readOnly ?? false;
		this.message = h(ownerDocument, "div");
		this.message.id = `ash-input-message-${inputBoxSequence++}`;
		this.message.className = "ash-input-box-message";
		setRole(this.message, "alert");
		this.message.hidden = true;
		this.element.append(this.inputElement, this.message);
		container.append(this.element);
		this.onKeyDown = this._register(new DomEmitter(this.inputElement, "keydown")).event;
		this.syncReadOnly();
		this._register(IME.onDidChange(() => this.syncReadOnly()));
		this._register(addDisposableListener(
			this.inputElement,
			"input",
			() => this._onDidChange.fire(this.value),
		));
		this._register(addDisposableListener(
			this.inputElement,
			"focus",
			() => {
				this.element.classList.add("is-focused");
				this._onDidFocus.fire();
			},
		));
		this._register(addDisposableListener(
			this.inputElement,
			"blur",
			() => {
				this.element.classList.remove("is-focused");
				this._onDidBlur.fire();
			},
		));
	}

	get value(): string {
		return this.inputElement.value;
	}

	set value(value: string) {
		if (this.inputElement.value === value) return;
		this.inputElement.value = value;
		this._onDidChange.fire(value);
	}

	get placeholder(): string {
		return this.inputElement.placeholder;
	}

	set placeholder(value: string) {
		this.inputElement.placeholder = value;
	}

	get step(): string {
		return this.inputElement.step;
	}

	set step(value: string) {
		this.inputElement.step = value;
	}

	get readOnly(): boolean {
		return this._readOnly;
	}

	set readOnly(value: boolean) {
		this._readOnly = value;
		this.syncReadOnly();
	}

	get enabled(): boolean {
		return !this.inputElement.disabled;
	}

	set enabled(value: boolean) {
		this.inputElement.disabled = !value;
		this.element.classList.toggle("is-disabled", !value);
	}

	get ariaActiveDescendant(): string | undefined {
		return getAriaAttribute(this.inputElement, "activedescendant");
	}

	set ariaActiveDescendant(value: string | undefined) {
		if (value) {
			setAriaAttribute(this.inputElement, "activedescendant", value);
		} else {
			setAriaAttribute(this.inputElement, "activedescendant", undefined);
		}
	}

	focus(): void {
		this.inputElement.focus();
	}

	blur(): void {
		this.inputElement.blur();
	}

	hasFocus(): boolean {
		return this.inputElement.ownerDocument.activeElement === this.inputElement;
	}

	select(selection?: InputSelection): void {
		if (selection) {
			this.inputElement.setSelectionRange(selection.start, selection.end);
		} else {
			this.inputElement.select();
		}
	}

	showValidation(message: string): void {
		this.message.textContent = message;
		this.message.hidden = !message;
		this.element.classList.toggle("has-validation", Boolean(message));
		if (message) {
			setAriaAttribute(this.inputElement, "invalid", true);
			setAriaAttribute(
				this.inputElement,
				"describedby",
				this.message.id,
			);
		} else {
			setAriaAttribute(this.inputElement, "invalid", undefined);
			setAriaAttribute(this.inputElement, "describedby", undefined);
		}
	}

	private syncReadOnly(): void {
		this.inputElement.readOnly = this._readOnly || !IME.enabled;
	}
}

export interface IHistoryInputOptions extends InputBoxOptions {
	readonly history?: IHistory<string>;
	readonly showHistoryHint?: () => boolean;
}

export class HistoryInputBox extends InputBox implements IHistoryNavigationWidget {
	private readonly navigator: HistoryNavigator<string>;
	private draft = '';
	private navigating = false;
	private applyingHistory = false;

	constructor(container: HTMLElement, private readonly historyOptions: IHistoryInputOptions = {}) {
		super(container, historyOptions);
		this.navigator = this._register(new HistoryNavigator(historyOptions.history, 100));
		this._register(this.onDidChange(() => {
			if (!this.applyingHistory) {
				this.resetNavigation();
			}
		}));
		this._register(this.onDidFocus(() => this.updateHistoryHint()));
		this._register(this.onDidBlur(() => this.inputElement.removeAttribute('aria-keyshortcuts')));
		if (historyOptions.history?.onDidChange) {
			this._register(historyOptions.history.onDidChange(() => this.updateHistoryHint()));
		}
	}

	public addToHistory(always = false): void {
		if (!this.value || (!always && this.navigator.getHistory().at(-1) === this.value)) {
			return;
		}
		this.navigator.add(this.value);
		this.resetNavigation();
		this.updateHistoryHint();
	}

	public prependHistory(values: readonly string[]): void {
		const current = this.navigator.getHistory();
		this.navigator.clear();
		for (const value of [...values, ...current]) {
			this.navigator.add(value);
		}
		this.resetNavigation();
		this.updateHistoryHint();
	}

	public getHistory(): string[] { return this.navigator.getHistory(); }
	public isAtFirstInHistory(): boolean { return this.navigator.isFirst(); }
	public isAtLastInHistory(): boolean { return this.navigator.isLast(); }
	public isNowhereInHistory(): boolean { return this.navigator.isNowhere(); }

	public showPreviousValue(): void {
		if (!this.navigating) {
			this.draft = this.value;
			this.navigator.reset();
		}
		const previous = this.navigator.previous();
		if (previous === null) {
			return;
		}
		this.navigating = true;
		this.applyHistory(previous);
	}

	public showNextValue(): void {
		if (!this.navigating) {
			return;
		}
		const next = this.navigator.next();
		if (next === null) {
			this.applyHistory(this.draft);
			this.resetNavigation();
			return;
		}
		this.applyHistory(next);
	}

	public clearHistory(): void {
		this.navigator.clear();
		this.resetNavigation();
		this.updateHistoryHint();
	}

	public resetNavigation(): void {
		this.navigating = false;
		this.navigator.reset();
	}

	private applyHistory(value: string): void {
		this.applyingHistory = true;
		try {
			this.value = value;
		} finally {
			this.applyingHistory = false;
		}
	}

	public updateHistoryHint(): void {
		if (this.hasFocus() && this.navigator.getHistory().length > 0 && this.historyOptions.showHistoryHint?.()) {
			this.inputElement.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
		} else {
			this.inputElement.removeAttribute('aria-keyshortcuts');
		}
	}
}

let inputBoxSequence = 1;
