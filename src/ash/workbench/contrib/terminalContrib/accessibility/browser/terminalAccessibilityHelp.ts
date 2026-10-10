import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewContentProvider } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';

export class TerminalAccessibilityHelpProvider extends Disposable implements IAccessibleViewContentProvider {
	public readonly id = AccessibleViewProviderId.TerminalHelp;
	public readonly options = { type: AccessibleViewType.Help };
	public readonly verbositySettingKey = AccessibilityVerbositySettingId.Terminal;

	constructor(private readonly instance: ITerminalInstance) { super(); }

	public provideContent(): string {
		return [
			localize('terminal.accessibility.overview', 'The terminal sends typed input to its running process. <keybinding:editor.action.accessibleView> opens the retained screen and scrollback as read-only text.'),
			localize('terminal.accessibility.find', '<keybinding:workbench.action.terminal.focusFind> opens Find. Enter and Shift+Enter navigate its matches. Escape returns focus to the terminal.'),
			localize('terminal.accessibility.reuse', 'A completed task waits for a character key or Enter to close its terminal. Workbench shortcuts remain available. presentation.showReuseMessage controls the reuse notice. A new task terminal displays a close notice.'),
			localize('terminal.accessibility.close', 'Escape closes accessibility help or the accessible view and returns focus to the terminal.'),
		].join('\n\n');
	}

	protected override disposeCore(): void {
		const screen = this.instance.xterm;
		if (screen && !screen.isDisposed) screen.focus();
	}
}
