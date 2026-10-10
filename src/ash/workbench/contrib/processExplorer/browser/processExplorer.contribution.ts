import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ProcessExplorerFocusedContext } from './processExplorerControl.js';
import { ProcessExplorerEditor } from './processExplorerEditor.js';
import { ProcessExplorerEditorInput } from './processExplorerEditorInput.js';

registerAction2(class OpenProcessExplorer extends Action2 {
	constructor() { super({ id: 'workbench.action.openProcessExplorer', title: localize2('processExplorer.open', 'Open Process Explorer'), f1: true, menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 2 } }); }
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IEditorService).openEditor(new ProcessExplorerEditorInput(), { pinned: true }); }
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 110, name: `processExplorer.${type}`, when: ProcessExplorerFocusedContext.isEqualTo(true),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof ProcessExplorerEditor)) { return undefined; }
			const control = pane.getControl();
			const focused = control.domNode.ownerDocument.activeElement as HTMLElement | null;
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.ProcessExplorer, { type },
				() => type === AccessibleViewType.View ? control.getAccessibleContent() : localize('processExplorer.help', 'Process Explorer displays local Desktop processes, CPU usage, resident memory in MiB and process IDs. Metrics reflect the last successful refresh.\nUse Up and Down to navigate, Right to expand and Left to collapse a process. Type a process name to find it. Use Tab and Shift+Tab to move between the tree and toolbar. Use Left and Right in the toolbar to reach Refresh and Copy process information. Refresh collects a new snapshot; Copy includes collapsed descendants.\nOpen Accessible View to read all processes as text. Escape closes accessibility help and returns focus to the previous control.'),
				() => { if (focused?.isConnected) { focused.focus(); } else if (!control.isDisposed) { control.focus(); } }, AccessibilityVerbositySettingId.ProcessExplorer);
			if (type === AccessibleViewType.View) { provider.onDidChangeContent = control.onDidChangeContent; }
			return provider;
		},
	});
}
