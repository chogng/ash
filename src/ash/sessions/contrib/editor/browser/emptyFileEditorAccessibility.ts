import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EmptyFileEditor, EmptyFileEditorFocusedContext } from './emptyFileEditor.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'emptyFileEditorHelp',
	priority: 110,
	when: EmptyFileEditorFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const editor = accessor.get(IEditorService).activeEditorPane;
		if (!(editor instanceof EmptyFileEditor)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.EmptyFileEditor,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.emptyFileEditor.help', 'Type part of a file name to search the workspace. Use the arrow keys to choose a result, Enter to open it, or Escape to return to the search field. Use Tab to reach Open file and New file.'),
			() => editor.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
