import { OutputViewPane } from './outputView.js';
import { localize } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewType,
	AccessibleViewProviderId,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
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
					localize(
						'output.help.overview',
						'Output is a read-only editor. New output updates this view and any editor opened for the same channel.',
					),
					localize(
						'output.help.navigation',
						'Use arrow keys to read output, Shift with arrow keys to select text, and Ctrl+C or Command+C to copy. Ctrl+F or Command+F opens Find.',
					),
					localize(
						'output.help.controls',
						'Use Tab and Shift+Tab to reach the channel selector, filters, Clear Output, Auto Scroll, and More Output Actions. Separate alternative text filters with commas and prefix exclusions with !. Spaces and - are literal. Severity and category filters only affect this view.',
					),
					localize(
						'output.help.filterLayout',
						'The filter is in the title bar. In narrow views with enough height, it moves above the output. The Auto Scroll button uses the Follow icon and stays selected while following new output; turn it off to read earlier messages.',
					),
					localize(
						'agentOutput.help',
						'The Agent channel shows execution summaries for the Session named in its channel selector. Show Agent Output in the conversation menu selects the current Session explicitly. Switching conversations does not replace the reviewed output. Use an execution link to open the saved event in Execution Trace. Clear Output keeps the saved trace, and Auto Scroll never changes execution or recording.',
					),
					localize(
						'output.help.categories',
						'Category choices apply to the selected channel. Older saved category choices apply to all channels until you change each category; only that category moves to the selected channel. Reset Filters clears category choices for all channels.',
					),
				];
				if (filters.textFilterNotice === 'restored') {
					content.push(
						localize(
							'output.filterRestored',
							'Saved filter restored. Edit or clear to use comma-separated filters.',
						),
					);
				} else if (filters.textFilterNotice === 'unsupported') {
					content.push(
						localize(
							'output.filterUnsupported',
							'A newer saved filter is preserved. Changes in this window are not saved.',
						),
					);
				}
				content.push(
					localize(
						'output.help.defaultLevel',
						'In Set Recording Level, Set As Default saves the current level for future windows. For extension logs it applies only to that extension. Loggers with a manually selected level keep that selection.',
					),
					localize(
						'output.help.windowLog',
						'Run Show Window Log from the Command Palette to select and focus the current Window log.',
					),
					localize(
						'output.help.savedLogs',
						'In desktop windows, Open Saved Logs opens current or retained log files. Live logs continue updating after reload. Clear Output clears this view from the current reading point and does not delete saved log files. The Set Recording Level menu is available only for producers that support it; it changes newly recorded messages, while display filters only hide existing messages.',
					),
					localize(
						'output.help.links',
						'Place the cursor on a file location and run <keybinding:editor.action.openLink>, or click it while holding Ctrl or Command. Workspace file locations open at their reported line and column.',
					),
					localize(
						'output.help.smartScroll',
						'With output.smartScroll.enabled, moving the primary cursor to an earlier line pauses Auto Scroll; moving it to the last line resumes it. Changing the setting affects the next cursor movement.',
					),
					localize(
						'output.help.scroll',
						'Scrolling away from the end pauses Auto Scroll. Enable it to follow new output. More Output Actions opens the live channel in an editor or exports its retained text.',
					),
				);
				return content.join('\n\n');
			},
			() => focused?.focus(),
			AccessibilityVerbositySettingId.Output,
		);
	}
}
