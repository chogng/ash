import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';

class TabFocusImpl extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<boolean>());
	private tabFocus = false;

	public readonly onDidChangeTabFocus: Event<boolean> = this.changeEmitter.event;

	public getTabFocusMode(): boolean {
		return this.tabFocus;
	}

	public setTabFocusMode(tabFocusMode: boolean): void {
		this.tabFocus = tabFocusMode;
		this.changeEmitter.fire(tabFocusMode);
	}
}

/** Process-wide policy deciding whether Tab edits text or advances browser focus. */
export const TabFocus = new TabFocusImpl();
