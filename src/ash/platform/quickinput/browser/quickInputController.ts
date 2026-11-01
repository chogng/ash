import './media/quickInput.css';
import { addDisposableListener, h, isHTMLElement } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { setAriaAttribute, setRole } from '../../../base/browser/ui/aria/aria.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { localize } from '../../../nls.js';
import { QuickInputHideReason, QuickInputType, type IInputOptions, type IQuickInput, type IQuickPick, type IQuickPickItem, type IQuickTree, type IQuickTreeItem, type IQuickWidget } from '../common/quickInput.js';
import { QuickTree } from './tree/quickTree.js';
import type { Context } from '../../contextkey/common/contextkey.js';
import { dispatchQuickInputKeyDown } from './quickInputActions.js';
import { QuickInput, QuickPick, QuickWidget, type BrowserQuickInputHostOptions, type IBrowserQuickInputHost } from './quickInput.js';
import { QuickInputBox } from './quickInputBox.js';
import { IStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IOpenerService } from '../../opener/common/opener.js';
import { IContextMenuService } from '../../contextview/browser/contextView.js';

const viewStateStorageKey = 'workbench.quickInput.viewState';

/** Fractions of the host: top edge vertically, horizontal center horizontally. */
interface QuickInputViewState {
	readonly top: number;
	readonly left: number;
}

/** Owns one container's picker overlay and restores the focus it displaced. */
export class QuickInputController extends Disposable {
	private readonly host: HTMLDivElement;
	private readonly quickInputs = new Set<IBrowserQuickInputHost>();
	private readonly shown = this._register(new Emitter<void>());
	private readonly hidden = this._register(new Emitter<void>());
	private active: IBrowserQuickInputHost | undefined;
	private focusToRestore: HTMLElement | undefined;
	private hidingFocus: HTMLElement | undefined;
	private readonly visibleListeners = this._register(new DisposableStore());
	private readonly dragListeners = this._register(new DisposableStore());
	private viewState: QuickInputViewState | undefined;
	public readonly onShow = this.shown.event;
	public readonly onHide = this.hidden.event;
	public get currentQuickInput(): IQuickInput | undefined {
		return this.active;
	}

	constructor(container: HTMLElement, className: string | undefined, private readonly callbacks: {
		readonly onShow?: (input: IQuickInput) => void;
		readonly onHide?: (input: IQuickInput) => void;
		readonly onContextKeyChange?: (input: IQuickInput) => void;
		readonly onFocus?: (inputOrList: boolean, atEnd: boolean) => void;
		readonly getContext?: (target: Node) => Context;
		readonly shouldRestoreFocus?: () => boolean;
		readonly onDispose?: () => void;
	},
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.host = h(container.ownerDocument, 'div');
		this.host.className = 'ash-quick-input-host';
		if (className) {
			this.host.classList.add(className);
		}
		this.host.hidden = true;
		container.append(this.host);
		this._register(observeResize(this.host, () => {
			this.layoutActiveInput();
		}));
		this._register(addDisposableListener(this.host, 'mousedown', event => this.startDrag(event)));
		this._register(addDisposableListener(this.host, 'dblclick', event => {
			if (event.button === 0 && this.isDragTarget(event.target)) {
				event.preventDefault();
				this.setAlignment('top');
			}
		}));
		this._register(addDisposableListener(this.host.ownerDocument, 'mousedown', event => {
			if (this.active?.ignoreFocusOut || this.active?.isContextMenuVisible) return;
			const anchor = this.active?.anchor;
			if (this.active && !event.composedPath().includes(this.host) && !(isHTMLElement(anchor) && event.composedPath().includes(anchor))) {
				this.active.hide(QuickInputHideReason.Blur);
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
			const within = this.active.type !== QuickInputType.QuickWidget && isHTMLElement(focused) && this.host.contains(focused) && !focused.closest('button, [role="tab"]');
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
		const quickPick = this.instantiationService.createInstance(QuickPick<TItem>, this.host, {
			onContextKeyChange: candidate => this.callbacks.onContextKeyChange?.(candidate),
			onShow: candidate => this.show(candidate),
			onHide: (candidate, reason) => this.hide(candidate, reason),
			onDispose: candidate => {
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		} satisfies BrowserQuickInputHostOptions);
		this.quickInputs.add(quickPick);
		return quickPick;
	}

	public createQuickWidget(): IQuickWidget {
		this.assertNotDisposed();
		const widget = this.instantiationService.createInstance(QuickWidget, this.host, {
			onContextKeyChange: candidate => this.callbacks.onContextKeyChange?.(candidate),
			onShow: candidate => this.show(candidate),
			onHide: (candidate, reason) => this.hide(candidate, reason),
			onDispose: candidate => {
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		} satisfies BrowserQuickInputHostOptions);
		this.quickInputs.add(widget);
		return widget;
	}

	public createQuickTree<T extends IQuickTreeItem>(): IQuickTree<T> {
		this.assertNotDisposed();
		const tree = this.instantiationService.createInstance(QuickTree<T>, this.host, {
			onContextKeyChange: candidate => this.callbacks.onContextKeyChange?.(candidate),
			onShow: candidate => this.show(candidate),
			onHide: (candidate, reason) => this.hide(candidate, reason),
			onDispose: candidate => { this.quickInputs.delete(candidate); this.hide(candidate); },
		} satisfies BrowserQuickInputHostOptions);
		this.quickInputs.add(tree);
		return tree;
	}

	public input(options: IInputOptions, token: CancellationToken = CancellationToken.None): Promise<string | undefined> {
		this.assertNotDisposed();
		if (token.isCancellationRequested) {
			return Promise.resolve(undefined);
		}
		let cancellation: IDisposable | undefined;
		const listeners = new DisposableStore();
		const input = this.instantiationService.createInstance(InputQuickInput, this.host, options, {
			onContextKeyChange: candidate => this.callbacks.onContextKeyChange?.(candidate),
			onShow: candidate => this.show(candidate),
			onHide: (candidate, reason) => this.hide(candidate, reason),
			onDispose: candidate => {
				cancellation?.dispose();
				listeners.dispose();
				this.quickInputs.delete(candidate);
				this.hide(candidate);
			},
		} satisfies BrowserQuickInputHostOptions);
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
			input.onDidAccept(value => finish(value), undefined, listeners);
			input.onDidHide(() => finish(undefined), undefined, listeners);
			input.onDidError(fail, undefined, listeners);
			cancellation = token.onCancellationRequested(() => finish(undefined));
			if (token.isCancellationRequested) {
				finish(undefined);
				return;
			}
			input.show();
		});
	}

	/** The host supplies geometry; saved positions remain relative to that host. */
	public layout(_dimension: { readonly width: number; readonly height: number; }, titleBarOffset: number): void {
		this.host.style.paddingTop = `${titleBarOffset + 8}px`;
		this.layoutActiveInput();
	}

	/** Custom coordinates use the same host-relative fractions as saved positions. */
	public setAlignment(alignment: 'top' | 'center' | { top: number; left: number; }): void {
		if (this.active?.anchor) return;
		this.dragListeners.clear();
		this.viewState = alignment === 'top' ? undefined : alignment === 'center' ? { top: 0.25, left: 0.5 } : alignment;
		this.saveViewState();
		this.layoutActiveInput();
	}

	private loadViewState(): QuickInputViewState | undefined {
		const stored = this.storageService.get(viewStateStorageKey, StorageScope.APPLICATION);
		if (!stored) return undefined;
		try {
			const value: unknown = JSON.parse(stored);
			if (typeof value !== 'object' || value === null) return undefined;
			const { top, left } = value as Record<string, unknown>;
			if (typeof top === 'number' && Number.isFinite(top) && top >= 0 && top <= 1
				&& typeof left === 'number' && Number.isFinite(left) && left >= 0 && left <= 1) {
				return { top, left };
			}
		} catch {
			// A damaged saved position must not prevent opening Quick Input.
		}
		return undefined;
	}

	private saveViewState(): void {
		if (this.viewState) {
			this.storageService.store(viewStateStorageKey, JSON.stringify(this.viewState), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(viewStateStorageKey, StorageScope.APPLICATION);
		}
	}

	private isDragTarget(target: EventTarget | null): boolean {
		if (!this.active || !isHTMLElement(target)) return false;
		if (this.active.anchor) return false;
		// Only surface/header whitespace is draggable; fields, tabs and actions keep their input behavior.
		return target === this.active.element
			|| target.parentElement === this.active.element && target.classList.contains('ash-quick-pick-input')
			|| !!target.closest('.ash-quick-input-titlebar') && !target.closest('button');
	}

	private startDrag(event: MouseEvent): void {
		if (event.button !== 0 || !this.isDragTarget(event.target)) return;
		event.preventDefault();
		this.dragListeners.clear();
		const input = this.active!;
		// Preventing the header's default mousedown keeps the current caret/selection intact.
		if (!input.element.contains(this.host.ownerDocument.activeElement)) input.focus();
		const start = input.element.getBoundingClientRect();
		const host = this.host.getBoundingClientRect();
		const scaleX = this.host.clientWidth / host.width;
		const scaleY = this.host.clientHeight / host.height;
		if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;
		const offsetX = (event.clientX - start.left) * scaleX;
		const offsetY = (event.clientY - start.top) * scaleY;
		let moved = false;
		const ownerWindow = this.host.ownerDocument.defaultView!;
		this.dragListeners.add(addDisposableListener(ownerWindow, 'mousemove', move => {
			if (move.buttons !== 1) { finish(); return; }
			move.preventDefault();
			const bounds = this.host.getBoundingClientRect();
			const width = this.host.clientWidth;
			const height = this.host.clientHeight;
			if (!width || !height) return;
			const maxLeft = Math.max(0, width - input.element.offsetWidth);
			const maxTop = Math.max(0, height - input.element.offsetHeight);
			let left = Math.max(0, Math.min(maxLeft, (move.clientX - bounds.left) * width / bounds.width - offsetX));
			let top = Math.max(0, Math.min(maxTop, (move.clientY - bounds.top) * height / bounds.height - offsetY));
			const centerX = Math.round(width / 2) - Math.round(input.element.offsetWidth / 2);
			const topInset = Number.parseFloat(ownerWindow.getComputedStyle(this.host).paddingTop);
			const snapTop = [topInset, Math.round(height * 0.25)].find(value => value <= maxTop && Math.abs(top - value) < 20);
			if (snapTop !== undefined) top = snapTop;
			if (Math.abs(left - centerX) < 20) left = centerX;
			this.viewState = { top: top / height, left: (left + input.element.offsetWidth / 2) / width };
			moved = true;
			this.layoutActiveInput();
		}));
		const finish = (): void => {
			this.dragListeners.clear();
			if (moved) this.saveViewState();
		};
		this.dragListeners.add(addDisposableListener(ownerWindow, 'mouseup', finish));
		this.dragListeners.add(addDisposableListener(ownerWindow, 'blur', finish));
	}

	private layoutActiveInput(): void {
		const input = this.active;
		if (!input) return;
		if (this.viewState && !input.anchor) {
			const element = input.element;
			const desiredLeft = this.viewState.left * this.host.clientWidth - element.offsetWidth / 2;
			const desiredTop = this.viewState.top * this.host.clientHeight;
			const left = Math.max(0, Math.min(this.host.clientWidth - element.offsetWidth, desiredLeft));
			const top = Math.max(0, Math.min(this.host.clientHeight - element.offsetHeight, desiredTop));
			// Translate the existing flex surface so its width, padding and typography stay unchanged.
			element.style.transform = `translate(${left - element.offsetLeft}px, ${top - element.offsetTop}px)`;
		} else {
			input.element.style.removeProperty('transform');
		}
		input.layout();
	}

	private show(quickPick: IBrowserQuickInputHost): void {
		if (this.active === quickPick) {
			quickPick.focus();
			return;
		}
		this.active?.hide();
		const focused = this.host.ownerDocument.activeElement;
		this.focusToRestore = this.hidingFocus ?? (isHTMLElement(focused) ? focused : undefined);
		this.active = quickPick;
		this.host.replaceChildren(quickPick.element);
		this.host.hidden = false;
		this.viewState = this.loadViewState();
		const anchor = quickPick.anchor;
		quickPick.element.classList.toggle('anchored', !!anchor);
		if (!anchor) for (const property of ['width', 'left', 'top']) quickPick.element.style.removeProperty(property);
		if (!isHTMLElement(anchor)) {
			this.visibleListeners.add(observeResize(quickPick.element, () => this.layoutActiveInput()));
		}
		const checkFocus = this.visibleListeners.add(new RunOnceScheduler(() => {
			const focused = this.host.ownerDocument.activeElement;
			if (!quickPick.ignoreFocusOut && !quickPick.isContextMenuVisible && !quickPick.element.contains(focused) && !(isHTMLElement(anchor) && anchor.contains(focused))) quickPick.hide(QuickInputHideReason.Blur);
		}, 0));
		this.visibleListeners.add(addDisposableListener(quickPick.element, 'focusout', () => checkFocus.schedule()));
		this.visibleListeners.add(addDisposableListener(this.host.ownerDocument.defaultView!, 'blur', () => {
			if (!quickPick.ignoreFocusOut && !quickPick.isContextMenuVisible) quickPick.hide(QuickInputHideReason.Blur);
		}));
		if (isHTMLElement(anchor)) {
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
			this.visibleListeners.add(addDisposableListener(this.host.ownerDocument, 'focusin', event => {
				if (!quickPick.ignoreFocusOut && !quickPick.isContextMenuVisible && !event.composedPath().includes(this.host) && !event.composedPath().includes(anchor)) quickPick.hide(QuickInputHideReason.Blur);
			}));
		}
		this.shown.fire();
		this.layoutActiveInput();
		this.callbacks.onShow?.(quickPick);
		quickPick.focus();
	}

	private hide(quickPick: IBrowserQuickInputHost, reason = QuickInputHideReason.Other): void {
		if (this.active !== quickPick) {
			return;
		}
		this.active = undefined;
		const shouldRestoreFocus = this.callbacks.shouldRestoreFocus?.() !== false && quickPick.element.contains(this.host.ownerDocument.activeElement);
		this.dragListeners.clear();
		this.visibleListeners.clear();
		const focusToRestore = this.focusToRestore;
		this.focusToRestore = undefined;
		this.hidingFocus = focusToRestore;
		try {
			quickPick.willHide(reason);
			quickPick.element.remove();
			if (!this.active) this.host.hidden = true;
			this.hidden.fire();
			this.callbacks.onHide?.(quickPick);
			if (!this.active && shouldRestoreFocus && focusToRestore?.isConnected) focusToRestore.focus({ preventScroll: true });
			quickPick.didHide(reason);
		} finally {
			this.hidingFocus = undefined;
		}
	}
}

class InputQuickInput extends QuickInput {
	public readonly type = QuickInputType.InputBox;
	public readonly onDidAccept: Event<string>;
	public readonly onDidError: Event<unknown>;
	private readonly inputBox: QuickInputBox;
	private readonly acceptEmitter = this._register(new Emitter<string>());
	private readonly errorEmitter = this._register(new Emitter<unknown>());

	constructor(host: HTMLElement, options: IInputOptions, hostOptions: BrowserQuickInputHostOptions, @IOpenerService opener: IOpenerService, @IContextMenuService menus: IContextMenuService) {
		super(host, hostOptions, opener, menus, 'ash-quick-pick');
		setRole(this.element, 'dialog');
		setAriaAttribute(this.element, 'label', options.title ?? localize('quickInput.inputTitle', 'Quick Input'));
		this.inputBox = this._register(new QuickInputBox(this.element, options));
		this.element.append(this.descriptionElement, this.progress);
		this.title = options.title;
		this.onDidAccept = this.acceptEmitter.event;
		this.onDidError = this.errorEmitter.event;
		this._register(this.inputBox.onDidAccept(value => {
			this.acceptEmitter.fire(value);
			this.hide();
		}));
		this._register(this.inputBox.onDidError(error => this.errorEmitter.fire(error)));
		this._register(this.onWillHide(() => this.inputBox.clear()));
	}

	protected override updateEnabled(): void { this.inputBox.enabled = this.enabled; }

	public focus(): void {
		this.inputBox.focus();
	}

	public async accept(): Promise<void> { if (this.enabled) await this.inputBox.accept(); }
}
