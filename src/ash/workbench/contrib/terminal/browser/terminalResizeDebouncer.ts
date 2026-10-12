import { runWhenWindowIdle } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { XtermTerminal } from './xterm/xtermTerminal.js';

/** Coalesces expensive screen reflow; process acknowledgement stays in the process manager. */
export class TerminalResizeDebouncer extends Disposable {
	private pending: { cols: number; rows: number; horizontalOnly: boolean; } | undefined;
	private readonly idle = this._register(new MutableDisposable<IDisposable>());
	private readonly scheduled = this._register(new RunOnceScheduler(() => this.flush(), 100));

	constructor(
		private readonly isVisible: () => boolean,
		private readonly getXterm: () => XtermTerminal | undefined,
		private readonly resizeBoth: (cols: number, rows: number) => void,
		private readonly resizeX: (cols: number) => void,
		private readonly resizeY: (rows: number) => void,
	) { super(); }

	public async resize(cols: number, rows: number, immediate: boolean): Promise<void> {
		if (this.isDisposed) return;
		const screen = this.getXterm();
		if (!screen || screen.isDisposed) return;
		this.pending = { cols, rows, horizontalOnly: false };
		if (immediate || screen.raw.buffer.normal.length < 200) {
			this.flush();
		} else if (this.isVisible()) {
			this.idle.clear();
			const request = this.pending;
			request.horizontalOnly = true;
			this.resizeY(rows);
			if (this.isDisposed || this.pending !== request) return;
			this.scheduled.schedule();
		} else {
			this.scheduled.cancel();
			this.idle.value ??= runWhenWindowIdle(screen.element.ownerDocument.defaultView!, () => this.flush(), 100);
		}
	}

	public flush(): void {
		if (this.isDisposed) return;
		this.scheduled.cancel();
		this.idle.clear();
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || this.getXterm()?.isDisposed !== false) return;
		if (pending.horizontalOnly) this.resizeX(pending.cols);
		else this.resizeBoth(pending.cols, pending.rows);
	}

	protected override disposeCore(): void {
		this.pending = undefined;
		super.disposeCore();
	}
}
