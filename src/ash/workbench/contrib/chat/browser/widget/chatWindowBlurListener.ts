import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';

/** Follows a Chat widget when its DOM is adopted into a different window. */
export class ChatWindowBlurListener extends Disposable {
	private readonly listener = this._register(new MutableDisposable());
	private window: Window | null = null;

	constructor(private readonly anchor: HTMLElement, private readonly onDidBlur: () => void) {
		super();
	}

	update(visible: boolean): void {
		const window = visible ? this.anchor.ownerDocument.defaultView : null;
		if (window === this.window) return;
		this.window = window;
		this.listener.value = window ? addDisposableListener(window, 'blur', this.onDidBlur) : undefined;
	}
}
