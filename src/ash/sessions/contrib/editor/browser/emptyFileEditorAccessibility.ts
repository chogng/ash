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
			() => localize('sessions.emptyFileEditor.help', 'Search for a file or enter a URL and press Enter. Choose Open File to show file results. Use Tab to reach the available actions. In Code, choose New File to create an untitled editor.'),
			() => editor.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
