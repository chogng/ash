import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalFindContribution } from './terminal.find.contribution.js';

export class TerminalFindAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 100;
	public readonly name = 'terminal-find';
	public readonly when = TerminalContextKeys.findFocus.isEqualTo(true);

	public getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const instance = accessor.get(ITerminalService).activeInstance;
		const widget = instance && TerminalFindContribution.get(instance)?.findWidget;
		if (!widget?.isVisible()) { return undefined; }
		const input = widget.getFindInputDomNode();
		const focused = input.ownerDocument.activeElement as HTMLElement | null;
		if (!widget.getDomNode().contains(focused)) { return undefined; }
		return new AccessibleContentProvider(
			AccessibleViewProviderId.TerminalFindHelp,
			{ type: AccessibleViewType.Help },
			() => [
				localize('terminal.find.help.overview', 'Find searches this terminal’s retained screen and scrollback. The result count is announced when it changes.'),
				localize('terminal.find.help.navigation', 'Type a search term. Enter moves to the next match; Shift+Enter moves to the previous match. <keybinding:workbench.action.terminal.findNext> and <keybinding:workbench.action.terminal.findPrevious> also navigate matches.'),
				localize('terminal.find.help.options', 'Tab moves through match case, whole word, regular expression, match navigation and close controls. Space toggles an option. Invalid regular expressions are announced and do not run.'),
				localize('terminal.find.help.close', 'Escape closes Find, clears search highlights and returns focus to the terminal. Escape closes this help and returns focus to the Find control.'),
			].join('\n\n'),
			() => { if (widget.isVisible() && input.isConnected) { (focused?.isConnected ? focused : input).focus(); } },
			AccessibilityVerbositySettingId.Find,
		);
	}
}
