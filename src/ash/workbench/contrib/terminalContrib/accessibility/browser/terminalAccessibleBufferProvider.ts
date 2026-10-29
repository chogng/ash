import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewContentProvider } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { BufferContentTracker } from './bufferContentTracker.js';


/** Reads the displayed buffer; process output and parser replies are not a second transcript. */
export class TerminalAccessibleBufferProvider extends Disposable implements IAccessibleViewContentProvider {
	public readonly id = AccessibleViewProviderId.Terminal;
	public readonly options = { type: AccessibleViewType.View };
	public readonly verbositySettingKey = AccessibilityVerbositySettingId.Terminal;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.changed.event;
	private readonly tracker: BufferContentTracker;

	constructor(private readonly instance: ITerminalInstance, private readonly screen: IXtermTerminal) {
		super();
		this.tracker = this._register(new BufferContentTracker(screen));
		const parsed = screen.raw.onWriteParsed(() => this.changed.fire());
		const resized = screen.raw.onResize(() => this.changed.fire());
		this._register(toDisposable(() => parsed.dispose()));
		this._register(toDisposable(() => resized.dispose()));
	}

	public provideContent(): string {
		if (this.screen.isDisposed) return '';
		this.tracker.update();
		const content = this.tracker.lines.join('\n').trimEnd();
		return content || localize('terminal.accessibility.empty', 'The terminal has no output.');
	}

	protected override disposeCore(): void {
		super.disposeCore();
		const screen = this.instance.xterm;
		if (screen && !screen.isDisposed) screen.focus();
	}
}
