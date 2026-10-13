import './media/quickInput.css';
import { addDisposableListener, h, isHTMLElement } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { setAriaAttribute, setRole } from '../../../base/browser/ui/aria/aria.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { localize } from '../../../nls.js';
import { QuickInputType, type IInputOptions, type IQuickInput, type IQuickPick, type IQuickPickItem } from '../common/quickInput.js';
import type { Context } from '../../contextkey/common/contextkey.js';
import { dispatchQuickInputKeyDown } from './quickInputActions.js';
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
	private readonly visibleListeners = this._register(new DisposableStore());
	public readonly onShow = this.shown.event;
	public readonly onHide = this.hidden.event;
	public get currentQuickInput(): IQuickInput | undefined {
		return this.active;
	}

	constructor(container: HTMLElement, className?: string, private readonly callbacks: {
		readonly onShow?: (input: IQuickInput) => void;
		readonly onHide?: (input: IQuickInput) => void;
		readonly onFocus?: (inputOrList: boolean, atEnd: boolean) => void;
		readonly getContext?: (target: Node) => Context;
		readonly shouldRestoreFocus?: () => boolean;
		readonly onDispose?: () => void;
	} = {}) {
		super();
		this.host = h(container.ownerDocument, 'div');
		this.host.className = 'ash-quick-input-host';
		if (className) {
			this.host.classList.add(className);
		}
		this.host.hidden = true;
		container.append(this.host);
		this._register(observeResize(this.host, () => {
			if (this.active instanceof QuickPick) this.active.layout();
		}));
		this._register(addDisposableListener(this.host.ownerDocument, 'mousedown', event => {
			const anchor = this.active instanceof QuickPick ? this.active.anchor : undefined;
			if (this.active && !event.composedPath().includes(this.host) && !(isHTMLElement(anchor) && event.composedPath().includes(anchor))) {
				this.active.hide();
			}
		}, true));
		// Modifier state belongs to the existing picker, including commands rebound by the host.
		const updateModifiers = (event: KeyboardEvent): void => {
			if (this.active instanceof QuickPick) this.active.keyMods = {
				ctrlCmd: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey,
			};
		};
		this._register(addDisposableListener(this.host.ownerDocument, 'keydown', updateModifiers, true));
		this._register(addDisposableListener(this.host.ownerDocument, 'keyup', updateModifiers, true));
		this._register(addDisposableListener(this.host, 'keydown', event => {
			if (this.active) {
				dispatchQuickInputKeyDown(event, this.active, this.callbacks.getContext?.(event.target as Node));
			}
		}));
		const updateFocus = (): void => {
			if (!this.active) return;
			const focused = this.host.ownerDocument.activeElement;
			const within = isHTMLElement(focused) && this.host.contains(focused) && !focused.closest('button, [role="tab"]');
			const field = focused?.tagName === 'INPUT' ? focused as HTMLInputElement : undefined;
			this.callbacks.onFocus?.(within, within && (!field || field.selectionStart === field.selectionEnd && field.selectionEnd === field.value.length));
		};
		for (const event of ['focusin', 'input', 'keyup', 'click'] as const) this._register(addDisposableListener(this.host, event, updateFocus));
		this._register(addDisposableListener(this.host, 'focusout', () => queueMicrotask(updateFocus)));
		this._register(addDisposableListener(this.host.ownerDocument, 'selectionchange', updateFocus));
		this._register(toDisposable(() => {
			for (const quickInput of [...this.quickInputs]) {
				quickInput.hide();
				quickInput.dispose();
			}
			this.quickInputs.clear();
			this.focusToRestore = undefined;
			this.host.remove();
			this.callbacks.onDispose?.();
		}));
	}

	/** The controller's own host is the boundary for scoped keybinding context. */
	public getDomNode(): HTMLElement { return this.host; }

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

	public input(options: IInputOptions, token: CancellationToken = CancellationToken.None): Promise<string | undefined> {
		this.assertNotDisposed();
		if (token.isCancellationRequested) {
			return Promise.resolve(undefined);
		}
		let cancellation: IDisposable | undefined;
		const input = new InputQuickInput(this.host, options, {
			onShow: candidate => this.show(candidate),
			onHide: candidate => this.hide(candidate),
			onDispose: candidate => {
				cancellation?.dispose();
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		});
		this.quickInputs.add(input);
		return new Promise((resolve, reject) => {
			let settled = false;
			// Cancellation belongs to this prompt, so a late token cannot hide a newer picker.
			const finish = (value: string | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				cancellation?.dispose();
				input.dispose();
				resolve(value);
			};
			const fail = (error: unknown): void => {
				if (settled) {
					return;
				}
				settled = true;
				cancellation?.dispose();
				input.dispose();
				reject(error);
			};
			input.onDidAccept(value => finish(value));
			input.onDidHide(() => finish(undefined));
			input.onDidError(fail);
			cancellation = token.onCancellationRequested(() => finish(undefined));
			if (token.isCancellationRequested) {
				finish(undefined);
				return;
			}
			input.show();
		});
	}

	/** The caller owns container geometry; the overlay only consumes its top offset. */
	public layout(_dimension: { readonly width: number; readonly height: number; }, titleBarOffset: number): void {
		this.host.style.paddingTop = `${titleBarOffset + 8}px`;
		if (this.active instanceof QuickPick) this.active.layout();
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
		const anchor = quickPick instanceof QuickPick ? quickPick.anchor : undefined;
		quickPick.element.classList.toggle('anchored', isHTMLElement(anchor));
		if (quickPick instanceof QuickPick && isHTMLElement(anchor)) {
			this.focusToRestore = anchor;
			const layout = (): void => quickPick.layout();
			// Composer content can move a toolbar button without changing the button's own size.
			const containers: HTMLElement[] = [];
			for (let container = anchor.parentElement; container; container = container.parentElement) containers.push(container);
			this.visibleListeners.add(observeResize([quickPick.element, anchor, ...containers], layout));
			this.visibleListeners.add(addDisposableListener(this.host.ownerDocument.defaultView!, 'resize', layout));
			this.visibleListeners.add(addDisposableListener(this.host.ownerDocument, 'scroll', layout, true));
			const viewport = this.host.ownerDocument.defaultView!.visualViewport;
			if (viewport) {
				this.visibleListeners.add(addDisposableListener(viewport, 'resize', layout));
				this.visibleListeners.add(addDisposableListener(viewport, 'scroll', layout));
			}
			const checkFocus = this.visibleListeners.add(new RunOnceScheduler(() => {
				// Native focus changes briefly pass through body before reaching the trigger.
				// Check after that transition; leaving the document produces no focusin event.
				const focused = this.host.ownerDocument.activeElement;
				if (!quickPick.element.contains(focused) && !anchor.contains(focused)) quickPick.hide();
			}, 0));
			this.visibleListeners.add(quickPick.onDidBlur(() => checkFocus.schedule()));
			this.visibleListeners.add(addDisposableListener(this.host.ownerDocument, 'focusin', event => {
				if (!event.composedPath().includes(this.host) && !event.composedPath().includes(anchor)) quickPick.hide();
			}));
		}
		this.shown.fire();
		this.callbacks.onShow?.(quickPick);
		quickPick.focus();
	}

	private hide(quickPick: IBrowserQuickInputHost): void {
		if (this.active !== quickPick) {
			return;
		}
		const shouldRestoreFocus = this.callbacks.shouldRestoreFocus?.() !== false && quickPick.element.contains(this.host.ownerDocument.activeElement);
		this.active = undefined;
		this.visibleListeners.clear();
		this.host.replaceChildren();
		this.host.hidden = true;
		const focusToRestore = this.focusToRestore;
		this.focusToRestore = undefined;
		this.hidden.fire();
		this.callbacks.onHide?.(quickPick);
		if (shouldRestoreFocus && focusToRestore?.isConnected) {
			focusToRestore.focus({ preventScroll: true });
		}
	}
}

class InputQuickInput extends Disposable implements IBrowserQuickInputHost {
	public readonly type = QuickInputType.InputBox;
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

	public accept(): Promise<void> { return this.inputBox.accept(); }
}
