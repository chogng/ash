import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EmptyFileEditor } from './emptyFileEditor.js';
import { EditorFilePickerFocusedContext } from './editorFilePicker.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'emptyFileEditorHelp',
	priority: 110,
	when: EditorFilePickerFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const editor = accessor.get(IEditorService).activeEditorPane;
		if (!(editor instanceof EmptyFileEditor)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.EmptyFileEditor,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.emptyFileEditor.help', 'Press Enter to search for files in the workspace. Choose a result to open it in the editor.'),
			() => editor.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
