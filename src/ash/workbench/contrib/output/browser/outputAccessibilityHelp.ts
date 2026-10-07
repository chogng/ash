import { OutputViewPane } from './outputView.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewType, AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CONTEXT_IN_OUTPUT, OUTPUT_VIEW_ID } from '../../../services/output/common/output.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

export class OutputAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 100;
	public readonly name = 'output';
	public readonly when = CONTEXT_IN_OUTPUT.isEqualTo(true);

	public getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const view = accessor.get(IViewsService).getActiveViewWithId(OUTPUT_VIEW_ID);
		if (!(view instanceof OutputViewPane)) {
			return undefined;
		}
		const focused = view.element.ownerDocument.activeElement as HTMLElement | null;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Output,
			{ type: AccessibleViewType.Help },
			() => [
				localize('output.help.overview', 'Output is a read-only editor. New output updates this view and any editor opened for the same channel.'),
				localize('output.help.navigation', 'Use arrow keys to read output, Shift with arrow keys to select text, and Ctrl+C or Command+C to copy. Ctrl+F or Command+F opens Find.'),
				localize('output.help.controls', 'Use Tab and Shift+Tab to reach the channel selector, filters, Clear Output, Auto Scroll, and More Output Actions. Text filters accept ! or - to exclude terms. Severity and category filters only affect this view.'),
				localize('output.help.links', 'Place the cursor on a file location and run <keybinding:editor.action.openLink>, or click it while holding Ctrl or Command. Workspace file locations open at their reported line and column.'),
				localize('output.help.scroll', 'Scrolling away from the end pauses Auto Scroll. Enable it to follow new output. More Output Actions opens the live channel in an editor or exports its retained text.'),
			].join('\n\n'),
			() => focused?.focus(),
			AccessibilityVerbositySettingId.Output,
		);
	}
}
