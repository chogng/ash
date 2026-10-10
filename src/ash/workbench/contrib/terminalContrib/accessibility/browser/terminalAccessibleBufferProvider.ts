import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewContentProvider } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';

/** Reads the displayed buffer; process output and parser replies are not a second transcript. */
export class TerminalAccessibleBufferProvider extends Disposable implements IAccessibleViewContentProvider {
	public readonly id = AccessibleViewProviderId.Terminal;
	public readonly options = { type: AccessibleViewType.View };
	public readonly verbositySettingKey = AccessibilityVerbositySettingId.Terminal;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.changed.event;

	constructor(private readonly instance: ITerminalInstance, private readonly screen: XtermTerminal) {
		super();
		const parsed = screen.raw.onWriteParsed(() => this.changed.fire());
		const resized = screen.raw.onResize(() => this.changed.fire());
		this._register(toDisposable(() => parsed.dispose()));
		this._register(toDisposable(() => resized.dispose()));
	}

	public provideContent(): string {
		if (this.screen.isDisposed) return '';
		const buffer = this.screen.raw.buffer.active;
		const lines: string[] = [];
		for (let index = 0; index < buffer.length; index++) {
			const row = buffer.getLine(index)!;
			const text = row.translateToString(!buffer.getLine(index + 1)?.isWrapped);
			if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		const content = lines.join('\n').trimEnd();
		return content || localize('terminal.accessibility.empty', 'The terminal has no output.');
	}

	protected override disposeCore(): void {
		const screen = this.instance.xterm;
		if (screen && !screen.isDisposed) screen.focus();
	}
}
