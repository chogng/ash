import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalWidget } from '../../../terminal/browser/widgets/widgets.js';
import './media/terminalResizeDimensionsOverlay.css';

/** A presentation of the committed grid size; it never requests a resize. */
export class TerminalResizeDimensionsOverlay extends Disposable implements ITerminalWidget {
	public readonly id = 'resize-dimensions-overlay';
	private readonly label: HTMLSpanElement;
	private readonly hide = this._register(
		new RunOnceScheduler(() => {
			this.label.hidden = true;
		}, 500),
	);

	constructor(container: HTMLElement, screen: IXtermTerminal) {
		super();
		this.label = container.ownerDocument.createElement('span');
		this.label.className = 'ash-terminal-resize-dimensions-overlay';
		this.label.hidden = true;
		// Resizing can produce many updates per second. Keep this visual feedback
		// out of the accessibility tree instead of interrupting terminal speech.
		this.label.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => this.label.remove()));
		const attachment = screen.attachWidget(this);
		if (attachment) this._register(attachment);
		const resized = screen.raw.onResize(({ cols, rows }) => {
			if (screen.isDisposed || screen.element.hidden || !screen.element.isConnected) return;
			this.label.textContent = localize('terminal.resizeDimensionsOverlay.dimensions', '{0} columns × {1} rows', cols, rows);
			this.label.hidden = false;
			this.hide.schedule();
		});
		this._register(toDisposable(() => resized.dispose()));
	}

	public attach(container: HTMLElement): void {
		container.append(this.label);
	}
}
