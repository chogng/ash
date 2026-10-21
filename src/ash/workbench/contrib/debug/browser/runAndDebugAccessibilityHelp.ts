import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import { DebugViewPaneContainer } from './debugViewlet.js';

export class RunAndDebugAccessibilityHelp implements IAccessibleViewImplementation {
	readonly type = AccessibleViewType.Help;
	readonly priority = 120;
	readonly name = 'runAndDebugHelp';

	getProvider(accessor: ServicesAccessor) {
		const container = accessor.get(IViewsService).getActiveViewPaneContainerWithId(WorkbenchViewContainerId.Debug);
		const focused = document.activeElement as HTMLElement | null;
		if (!(container instanceof DebugViewPaneContainer) || !container.element.contains(focused)) return undefined;
		return new AccessibleContentProvider(AccessibleViewProviderId.RunAndDebug, { type: this.type },
			() => [localize('debug.sidebarHelp', 'Run and Debug\nUse Tab to move between the launch configuration, debug controls and views. Press Enter or Space on a view heading to collapse or expand it. Use the view menu to hide or show individual views; visibility is saved for this profile.\nStart debugging with <keybinding:workbench.action.debug.start>. Use <keybinding:workbench.action.debug.selectandstart> to select another configuration, including dynamic configurations.\nVariables: expand a variable with Enter. Press F2 to change an editable value, Enter to apply, or Escape to cancel. Watch: use Add watch expression to enter an expression and use its Remove button to delete it.\nCall Stack: select a thread, then activate a frame to open its source. The paused frame is highlighted in the editor. Breakpoints: use the toolbar to add or remove breakpoints and the checkbox to enable or disable them. Conditions and log messages use the breakpoint edit form.\nLoaded Scripts: show the view from the view menu, filter the list and press Enter on a script to open its source. Use Debug: Open Loaded Script to search without opening the view. Debug: View Memory opens a paused memory range as hex; preserve its byte count when editing and save to write through the adapter. Reopen after continuing. Debug: Visualize Variable opens a variable tree or an extension visualization. In Chat, Add Context offers paused Debug frame and variable snapshots.\nOpen Debug Console with <keybinding:workbench.debug.action.focusRepl>. Quick Access accepts “debug ” for configurations and “debug consoles ” for live or retained consoles. Press Escape to return to the focused control.'),
			localize('debug.javascriptWorkflowHelp', 'JavaScript and TypeScript: set debug.javascript.autoAttachFilter to always, smart or onlyWithFlag, then create a new integrated terminal to attach automatically. Configure serverReadyAction in launch.json to open a server URL or start another debug configuration when its output matches. Stop Debugging detaches attached terminal programs; use the terminal to end them.'),
			localize('debug.autoAttachControlsHelp', 'Debug: Toggle Auto Attach opens a keyboard-accessible picker for the mode and User or Workspace Settings. When enabled, the Auto Attach status bar entry shows the current mode and opens the same picker. Temporarily Disable Auto Attach pauses attachment of new programs without changing settings or existing debug sessions. Re-enable Auto Attach resumes in the same terminal. Changing auto attach settings or restarting the extension clears the pause.')].join('\n'),
			() => { if (focused?.isConnected) focused.focus(); else container.focus(); }, AccessibilityVerbositySettingId.Debug);
	}
}
