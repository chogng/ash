import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { findFocusedDiffEditor } from './commands.js';
import { DiffEditorWidget } from './diffEditorWidget.js';

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 120,
	name: 'diffEditorHelp',
	getProvider: accessor => {
		const editor = findFocusedDiffEditor(accessor);
		if (!editor) return undefined;
		const previousFocus = editor.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DiffEditor,
			{ type: AccessibleViewType.Help },
			() => localize('diffEditor.accessibleViewer.help', 'Diff editor\nPress F7 to open the accessible diff viewer and move to the next difference. Press Shift+F7 for the previous difference. In the viewer, use Tab to reach the navigation and close buttons, or press Escape to return to the editor. Press Alt+F2 to read all differences. Press Alt+F5 to move between changes in the editor. Use Tab to reach change actions and revert buttons, then Enter or Space to run them. Reverting a change can be undone. When moved code is shown, use its button to compare the moved block. Only changes inside that block are highlighted. Press Escape or use Stop comparing moved code to return to the full comparison. Selecting hidden lines reveals them on both sides.'),
			() => restoreFocus(previousFocus, editor),
			AccessibilityVerbositySettingId.DiffEditor,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 120,
	name: 'diffEditorView',
	getProvider: accessor => {
		const editor = findFocusedDiffEditor(accessor);
		if (!editor) return undefined;
		const previousFocus = editor.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DiffEditor,
			{ type: AccessibleViewType.View },
			() => editor.getAccessibleContent(),
			() => restoreFocus(previousFocus, editor),
			AccessibilityVerbositySettingId.DiffEditor,
		);
	},
});

function restoreFocus(previousFocus: Element | null, editor: DiffEditorWidget): void {
	if (isHTMLElement(previousFocus) && previousFocus.isConnected) previousFocus.focus();
	else editor.focus();
}
