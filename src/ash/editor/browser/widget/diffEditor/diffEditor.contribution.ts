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
			() => [
				localize('diffEditor.editing.help', 'The modified side supports regular editor commands, including Find, Hover and completion when a provider is available. The original side remains read-only. Use <keybinding:editor.action.toggleWordWrap> to temporarily toggle wrapping; language-specific editor and diff settings determine the configured mode. Breadcrumbs show the modified file and its current symbol. Focus breadcrumbs, use arrow keys to choose an item, and Enter to open its picker. Escape closes the picker and returns focus.'),
				localize('diffEditor.whitespace.help', 'Show Leading/Trailing Whitespace Differences controls whether changes to spaces and tabs at the start or end of a line count as differences. When unchecked, these changes are ignored; spaces within a line still count. Toggling this option recomputes the comparison without editing either file. Render Whitespace separately controls the visibility of whitespace characters.'),
				localize('scrollLocking.diffHelp', '<keybinding:workbench.action.toggleLockedScrolling> toggles locked scrolling across visible editors while preserving their relative positions. A comparison participates through its modified side; its two sides keep their existing synchronization. Bind Hold Locked Scrolling Across Editors to temporarily toggle the state until the shortcut is released or the window loses focus. Activate the Scrolling Locked status bar entry to disable it.'),
				localize('diffEditor.statusBar.help', 'The status bar follows the focused side of the comparison. Activate the position entry to go to a line or column. Use Left and Right arrows in the status bar and Enter to run an action. Indentation, encoding, line endings, and language actions open a picker; Escape cancels it. Reopen with Encoding suggests a detected encoding. Default encoding and automatic detection can be configured per language. Line endings can only be changed on a writable side, and the change can be undone.'),
				localize('diffEditor.accessibleViewer.help', 'Diff editor\nPress F7 to open the accessible diff viewer and move to the next difference. Press Shift+F7 for the previous difference. In the viewer, use Tab to reach the navigation and close buttons, or press Escape to return to the editor. Press Alt+F2 to read all differences. Press Alt+F5 to move between changes in the editor. Use Tab to reach change actions and revert buttons, then Enter or Space to run them. Reverting a change can be undone. When moved code is shown, use its button to compare the moved block. Only changes inside that block are highlighted. Press Escape or use Stop comparing moved code to return to the full comparison. Selecting hidden lines reveals them on both sides.'),
				localize('diffEditor.toolbar.help', 'Use the editor toolbar More Actions menu to choose an inline, side by side, or automatic diff layout, show leading/trailing whitespace differences, or swap the original and modified sides. Use arrow keys to navigate the menu, Enter to run an action, and Escape to close it. The center gutter provides change actions. In a Source Control comparison, use Stage change or Unstage change to update only that block. Selecting changed lines provides selection actions. Revert change updates the modified editor and can be undone. Save the file to write the reverted content to disk. In a multi-file diff, use the editor title toolbar to collapse or expand all files or toggle unchanged regions. Files start expanded, with unchanged code hidden. Use Enter or Space on the hidden-region buttons to reveal more lines. Drag the upper edge down or the lower edge up to reveal lines, and reverse the drag to hide them again, or double-click the hidden line count to reveal the whole region. Once the region is fully visible, use its Collapse unchanged region button in either editor margin to hide it again.'),
			].join('\n'),
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
