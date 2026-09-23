import './media/quickInput.css';
import { addDisposableListener, h, isHTMLElement, stopEvent } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IQuickPick, IQuickPickItem } from '../common/quickInput.js';
import { QuickPick, type IBrowserQuickPickHost } from './quickInput.js';

/** Owns one container's picker overlay and restores the focus it displaced. */
export class QuickInputController extends Disposable {
	private readonly host: HTMLDivElement;
	private readonly quickPicks = new Set<IBrowserQuickPickHost>();
	private readonly shown = this._register(new Emitter<void>());
	private readonly hidden = this._register(new Emitter<void>());
	private active: IBrowserQuickPickHost | undefined;
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
		this._register(addDisposableListener(this.host, 'mousedown', event => {
			if (event.target === this.host) {
				stopEvent(event);
				this.active?.hide();
			}
		}));
		this._register(toDisposable(() => {
			for (const quickPick of [...this.quickPicks]) {
				quickPick.dispose();
			}
			this.quickPicks.clear();
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
				this.quickPicks.delete(candidate);
				this.hide(candidate);
			},
		});
		this.quickPicks.add(quickPick);
		return quickPick;
	}

	/** The caller owns container geometry; the overlay only consumes its top offset. */
	public layout(_dimension: { readonly width: number; readonly height: number }, titleBarOffset: number): void {
		this.host.style.paddingTop = `${titleBarOffset + 8}px`;
	}

	private show(quickPick: IBrowserQuickPickHost): void {
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

	private hide(quickPick: IBrowserQuickPickHost): void {
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
