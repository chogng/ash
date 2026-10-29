import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDebugSession, IDebugStackFrame, IDebugThread, IViewModel } from './debug.js';

/** Window-owned inspection selection. Runtime state and inspected values stay in Rust. */
export class ViewModel extends Disposable implements IViewModel {
	private readonly updates = this._register(new Emitter<void>());
	readonly onWillUpdateViews = this.updates.event;

	updateViews(): void {
		if (!this.isDisposed) this.updates.fire();
	}

	private session: IDebugSession | undefined;
	private thread: IDebugThread | undefined;
	private stackFrame: IDebugStackFrame | undefined;
	private readonly frameFocus = this._register(
		new Emitter<{
			stackFrame: IDebugStackFrame | undefined;
			explicit: boolean;
			session: IDebugSession | undefined;
		}>(),
	);
	readonly onDidFocusStackFrame = this.frameFocus.event;
	private readonly threadFocus = this._register(new Emitter<{ thread: IDebugThread | undefined; explicit: boolean; session: IDebugSession | undefined }>());
	readonly onDidFocusThread = this.threadFocus.event;
	get focusedSession(): IDebugSession | undefined {
		return this.session;
	}
	get focusedThread(): IDebugThread | undefined {
		return this.thread;
	}
	get focusedStackFrame(): IDebugStackFrame | undefined {
		return this.stackFrame;
	}

	setFocus(stackFrame: IDebugStackFrame | undefined, thread: IDebugThread | undefined, session: IDebugSession | undefined, explicit: boolean): void {
		if (this.isDisposed) return;
		const frameChanged = this.stackFrame !== stackFrame || (this.session !== session && stackFrame !== undefined);
		const threadChanged = this.thread !== thread;
		// Publish the selection as one coherent snapshot before notifying any view.
		// Frame and thread identifiers may be reused by another session or pause.
		this.session = session;
		this.thread = thread;
		this.stackFrame = stackFrame;
		if (frameChanged) this.frameFocus.fire({ stackFrame, explicit, session });
		else if (threadChanged) this.threadFocus.fire({ thread, explicit, session });
	}
}
