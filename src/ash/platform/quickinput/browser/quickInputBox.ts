import { defaultInputBoxStyles } from '../../theme/browser/defaultStyles.js';
import { stopEvent } from '../../../base/browser/dom.js';
import { InputBox } from '../../../base/browser/ui/inputbox/inputbox.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IInputOptions } from '../common/quickInput.js';

/** Owns the input field used by a Quick Input prompt. */
export class QuickInputBox extends Disposable {
	public readonly onDidAccept: Event<string>;
	public readonly onDidError: Event<unknown>;
	private readonly inputBox: InputBox;
	private readonly acceptEmitter = this._register(new Emitter<string>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private validating = false;

	constructor(container: HTMLElement, private readonly options: IInputOptions) {
		super();
		this.inputBox = this._register(new InputBox(container, {
			inputBoxStyles: defaultInputBoxStyles,
			type: options.password ? 'password' : 'text',
			placeholder: options.placeHolder,
			ariaLabel: options.title ?? options.placeHolder ?? localize('quickInput.inputTitle', 'Quick Input'),
		}));
		this.inputBox.element.classList.add('ash-quick-pick-input');
		if (options.value !== undefined) this.inputBox.value = options.value;
		if (options.validationMessage) this.inputBox.showValidation(options.validationMessage);
		this.onDidAccept = this.acceptEmitter.event;
		this.onDidError = this.errorEmitter.event;
		this._register(this.inputBox.onDidChange(() => this.inputBox.showValidation('')));
		this._register(this.inputBox.onKeyDown(event => {
			if (event.key === 'Tab') {
				stopEvent(event);
				this.focus();
				return;
			}
		}));
		this._register(toDisposable(() => this.clear()));
	}

	public focus(): void {
		this.inputBox.focus();
	}

	public clear(): void {
		this.inputBox.value = '';
	}

	public async accept(): Promise<void> {
		if (this.validating) {
			return;
		}
		this.validating = true;
		const value = this.inputBox.value;
		try {
			const message = await this.options.validateInput?.(value);
			if (this.isDisposed) {
				return;
			}
			if (message) {
				this.inputBox.showValidation(message);
				return;
			}
			this.clear();
			this.acceptEmitter.fire(value);
		} catch (error) {
			if (!this.isDisposed) {
				this.errorEmitter.fire(error);
			}
		} finally {
			this.validating = false;
		}
	}
}
