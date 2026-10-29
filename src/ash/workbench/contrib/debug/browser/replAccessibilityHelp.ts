import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	type IAccessibleViewContentProvider,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getReplView } from './repl.js';
import { localize } from '../../../../nls.js';

/** Borrows the console view; output, input and focus remain owned by Repl. */
export class ReplAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 110;
	public readonly name = 'debug.repl.help';

	public getProvider(accessor: ServicesAccessor): IAccessibleViewContentProvider | undefined {
		const view = getReplView(accessor.get(IViewsService));
		const focused = view?.element.ownerDocument.activeElement as HTMLElement | null;
		if (!view || !focused || !view.element.contains(focused)) {
			return undefined;
		}
		const provider = new AccessibleContentProvider(
			AccessibleViewProviderId.Repl,
			{ type: this.type },
			() =>
				localize(
					'debug.repl.help',
					'Debug Console\nEnter an expression and press Enter to evaluate it in the selected session and stack frame. Press Shift+Enter to insert a new line. The expression editor supports selection, undo and redo. Use Tab to reach the session selector, output, groups, objects and source buttons. Use Up and Down in the output tree to navigate, and Right and Left to expand or collapse groups and objects. Press Enter on a source button to open its location. Use Up on the first line and Down on the last line to recall history and restore your draft. Press Control+Space to request suggestions; use Up and Down to select, Enter or Tab to insert, and Escape to dismiss without evaluating. Suggestions use the selected session, stack frame and cursor position. Press Control+F or Command+F to focus the filter. Separate alternatives with commas and prefix exclusions with !. Press Enter in the filter to save its history. Escape clears the filter, then returns to output. Clear Console removes retained output and keeps input history. Open Accessible View to read the filtered output as text. Press Escape to return to the console.',
				) +
				'\n' +
				localize(
					'debug.repl.findHelp',
					'Use Find or Control+Alt+F / Command+Alt+F to find in output without changing the filter or expression draft. Enter finds the next match, Shift+Enter finds the previous match, and Escape closes Find and returns to the output tree.',
				) +
				'\n' +
				localize(
					'debug.repl.linksHelp',
					'Use Ctrl/Cmd+click or focus a text link and press Enter to open it. Hold Shift to open a file beside the current editor. File links use the originating live session workspace; unavailable files remain plain text.',
				),
			() => {
				if (focused.isConnected) {
					focused.focus();
				} else {
					view.focus();
				}
			},
			AccessibilityVerbositySettingId.DebugConsole,
		);
		return provider;
	}
}
