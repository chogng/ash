import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { EmptyFileEditor } from './emptyFileEditor.js';
import { EditorFilePickerFocusedContext } from './editorFilePicker.js';
import { NewTabEditor } from './newTabEditor.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'emptyFileEditorHelp',
	priority: 110,
	when: EditorFilePickerFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const editor = accessor.get(IEditorService).activeEditorPane;
		if (!(editor instanceof EmptyFileEditor || editor instanceof NewTabEditor)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.EmptyFileEditor,
			{ type: AccessibleViewType.Help },
			() => editor instanceof NewTabEditor
				? localize('sessions.editorStart.help', 'Search for a file or enter a URL and press Enter. Use Tab to reach the tools under Open. Choosing a tool replaces this New Tab. Escape cancels the file picker and returns here.')
				: localize('sessions.emptyFileEditor.help', 'Press Enter to search for files in the workspace. Choose a result to open it in the editor.'),
			() => editor.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
