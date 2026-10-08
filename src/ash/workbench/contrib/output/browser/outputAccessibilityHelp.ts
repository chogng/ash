import { OutputViewPane } from './outputView.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewType, AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CONTEXT_IN_OUTPUT, IOutputService, OUTPUT_VIEW_ID } from '../../../services/output/common/output.js';
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
		const filters = accessor.get(IOutputService).filters;
		const focused = view.element.ownerDocument.activeElement as HTMLElement | null;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Output,
			{ type: AccessibleViewType.Help },
			() => {
				const content = [
					localize('output.help.overview', 'Output is a read-only editor. New output updates this view and any editor opened for the same channel.'),
					localize('output.help.navigation', 'Use arrow keys to read output, Shift with arrow keys to select text, and Ctrl+C or Command+C to copy. Ctrl+F or Command+F opens Find.'),
					localize('output.help.controls', 'Use Tab and Shift+Tab to reach the channel selector, filters, Clear Output, Auto Scroll, and More Output Actions. Separate alternative text filters with commas and prefix exclusions with !. Spaces and - are literal. Severity and category filters only affect this view.'),
					localize('output.help.categories', 'Category choices apply to the selected channel. Older saved category choices apply to all channels until you change each category; only that category moves to the selected channel. Reset Filters clears category choices for all channels.'),
				];
				if (filters.textFilterNotice === 'restored') {
					content.push(localize('output.filterRestored', 'Saved filter restored. Edit or clear to use comma-separated filters.'));
				} else if (filters.textFilterNotice === 'unsupported') {
					content.push(localize('output.filterUnsupported', 'A newer saved filter is preserved. Changes in this window are not saved.'));
				}
				content.push(
					localize('output.help.links', 'Place the cursor on a file location and run <keybinding:editor.action.openLink>, or click it while holding Ctrl or Command. Workspace file locations open at their reported line and column.'),
					localize('output.help.smartScroll', 'With output.smartScroll.enabled, moving the primary cursor to an earlier line pauses Auto Scroll; moving it to the last line resumes it. Changing the setting affects the next cursor movement.'),
					localize('output.help.scroll', 'Scrolling away from the end pauses Auto Scroll. Enable it to follow new output. More Output Actions opens the live channel in an editor or exports its retained text.'),
				);
				return content.join('\n\n');
			},
			() => focused?.focus(),
			AccessibilityVerbositySettingId.Output,
		);
	}
}
