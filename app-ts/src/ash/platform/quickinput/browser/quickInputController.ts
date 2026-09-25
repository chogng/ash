import './media/quickInput.css';
import { addDisposableListener, h, isHTMLElement } from '../../../base/browser/dom.js';
import { setAriaAttribute, setRole } from '../../../base/browser/ui/aria/aria.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IInputOptions, IQuickPick, IQuickPickItem } from '../common/quickInput.js';
import { QuickPick, type BrowserQuickInputHostOptions, type IBrowserQuickInputHost } from './quickInput.js';
import { QuickInputBox } from './quickInputBox.js';

/** Owns one container's picker overlay and restores the focus it displaced. */
export class QuickInputController extends Disposable {
	private readonly host: HTMLDivElement;
	private readonly quickInputs = new Set<IBrowserQuickInputHost>();
	private readonly shown = this._register(new Emitter<void>());
	private readonly hidden = this._register(new Emitter<void>());
	private active: IBrowserQuickInputHost | undefined;
	private focusToRestore: HTMLElement | undefined;
	public readonly onShow = this.shown.event;
	public readonly onHide = this.hidden.event;

	constructor(container: HTMLElement, className?: string) {
		super();
		this.host = h(container.ownerDocument, 'div');
		this.host.className = 'ash-quick-input-host';
		if (className) {
			this.host.classList.add(className);
		}
		this.host.hidden = true;
		container.append(this.host);
		this._register(addDisposableListener(this.host.ownerDocument, 'mousedown', event => {
			if (this.active && !event.composedPath().includes(this.host)) {
				this.active.hide();
			}
		}, true));
		this._register(toDisposable(() => {
			for (const quickInput of [...this.quickInputs]) {
				quickInput.hide();
				quickInput.dispose();
			}
			this.quickInputs.clear();
			this.focusToRestore = undefined;
			this.host.remove();
		}));
	}

	public createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		this.assertNotDisposed();
		const quickPick = new QuickPick<TItem>(this.host, {
			onShow: candidate => this.show(candidate),
			onHide: candidate => this.hide(candidate),
			onDispose: candidate => {
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		});
		this.quickInputs.add(quickPick);
		return quickPick;
	}

	public input(options: IInputOptions): Promise<string | undefined> {
		this.assertNotDisposed();
		const input = new InputQuickInput(this.host, options, {
			onShow: candidate => this.show(candidate),
			onHide: candidate => this.hide(candidate),
			onDispose: candidate => {
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		});
		this.quickInputs.add(input);
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (value: string | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				input.dispose();
				resolve(value);
			};
			const fail = (error: unknown): void => {
				if (settled) {
					return;
				}
				settled = true;
				input.dispose();
				reject(error);
			};
			input.onDidAccept(value => finish(value));
			input.onDidHide(() => finish(undefined));
			input.onDidError(fail);
			input.show();
		});
	}

	/** The caller owns container geometry; the overlay only consumes its top offset. */
	public layout(_dimension: { readonly width: number; readonly height: number }, titleBarOffset: number): void {
		this.host.style.paddingTop = `${titleBarOffset + 8}px`;
	}

	private show(quickPick: IBrowserQuickInputHost): void {
		if (this.active === quickPick) {
			quickPick.focus();
			return;
		}
		this.active?.hide();
		const focused = this.host.ownerDocument.activeElement;
		this.focusToRestore = isHTMLElement(focused) ? focused : undefined;
		this.active = quickPick;
		this.host.replaceChildren(quickPick.element);
		this.host.hidden = false;
		this.shown.fire();
		quickPick.focus();
	}

	private hide(quickPick: IBrowserQuickInputHost): void {
		if (this.active !== quickPick) {
			return;
		}
		const shouldRestoreFocus = quickPick.element.contains(this.host.ownerDocument.activeElement);
		this.active = undefined;
		this.host.replaceChildren();
		this.host.hidden = true;
		const focusToRestore = this.focusToRestore;
		this.focusToRestore = undefined;
		this.hidden.fire();
		if (shouldRestoreFocus && focusToRestore?.isConnected) {
			focusToRestore.focus();
		}
	}
}

class InputQuickInput extends Disposable implements IBrowserQuickInputHost {
	public readonly element: HTMLDivElement;
	public readonly onDidAccept: Event<string>;
	public readonly onDidHide: Event<void>;
	public readonly onDidError: Event<unknown>;
	private readonly inputBox: QuickInputBox;
	private readonly acceptEmitter = this._register(new Emitter<string>());
	private readonly hideEmitter = this._register(new Emitter<void>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());
	private visible = false;

	constructor(host: HTMLElement, options: IInputOptions, private readonly hostOptions: BrowserQuickInputHostOptions) {
		super();
		this.element = h(host.ownerDocument, 'div');
		this.element.className = 'ash-quick-pick';
		setRole(this.element, 'dialog');
		setAriaAttribute(this.element, 'label', options.title ?? localize('quickInput.inputTitle', 'Quick Input'));
		this.inputBox = this._register(new QuickInputBox(this.element, options));
		this.onDidAccept = this.acceptEmitter.event;
		this.onDidHide = this.hideEmitter.event;
		this.onDidError = this.errorEmitter.event;
		this._register(this.inputBox.onDidAccept(value => {
			this.acceptEmitter.fire(value);
			this.hide();
		}));
		this._register(this.inputBox.onDidCancel(() => this.hide()));
		this._register(this.inputBox.onDidError(error => this.errorEmitter.fire(error)));
		this._register(toDisposable(() => {
			this.hide();
			hostOptions.onDispose(this);
			this.element.remove();
		}));
	}

	public show(): void {
		if (this.visible) {
			this.focus();
			return;
		}
		this.visible = true;
		this.hostOptions.onShow(this);
		this.focus();
	}

	public hide(): void {
		if (!this.visible) {
			return;
		}
		this.visible = false;
		this.inputBox.clear();
		this.hostOptions.onHide(this);
		this.hideEmitter.fire();
	}

	public focus(): void {
		this.inputBox.focus();
	}
}
