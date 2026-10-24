import { Disposable, DisposableMap, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';

let nextEditorHelpRegistration = 1;

export class EditorAccessibilityHelpContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'editorAccessibilityHelpContribution';
	private readonly editors = this._register(new DisposableMap<ICodeEditor, IDisposable>());

	constructor(
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		// The registry belongs to the realm; each window owns its registration
		// and only supplies content to commands from that window's services.
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help,
			priority: 90,
			name: `editor-${nextEditorHelpRegistration++}`,
			when: EditorContextKeys.editorTextFocus.isEqualTo(true),
			getProvider: accessor => {
				if (accessor.get(ICodeEditorService) !== this.codeEditors) {
					return undefined;
				}
				const editor = this.codeEditors.getFocusedCodeEditor();
				if (!editor || editor.isSimpleWidget) {
					return undefined;
				}
				return new AccessibleContentProvider(
					AccessibleViewProviderId.Editor,
					{ type: AccessibleViewType.Help },
					() => [
						editor.getOption(EditorOption.readOnly)
							? localize('accessibility.editorReadOnly', 'You are in a read-only text editor.')
							: localize('accessibility.editorEditable', 'You are in an editable text editor.'),
						this.accessibility.isScreenReaderOptimized()
							? localize('accessibility.editorScreenReaderOn', 'Screen reader optimization is enabled.')
							: localize('accessibility.editorScreenReaderOff', 'Screen reader optimization is disabled.'),
						localize('accessibility.editorWindows', 'The Command Palette offers New Empty Editor Window, Move or Copy Editor Group into New Window, and Close Window. Zoom commands apply to the current window when Zoom per window is enabled. Closing an editor window returns unsaved editors to the main window. The title bar pin toggles whether the window stays on top.'),
						localize('accessibility.editorRead', 'Use arrow keys to read text, Shift with arrow keys to select, and Ctrl+C or Command+C to copy. <keybinding:actions.find> opens Find.'),
						...(editor.getModel()?.uri.scheme === 'ash-binary-preview' ? [localize('accessibility.binaryComparison', 'This is a read-only hexadecimal preview. Each row contains sixteen byte offsets, hexadecimal values, and their ASCII representation. Binary comparisons align by byte offset and synchronize scrolling between Original and Modified. Highlighted bytes differ; dashes indicate missing bytes. The heading reports the number of differing bytes in the preview. Compressed files can have many differing bytes after a small source change.')] : []),
						localize('inlayHints.help', 'Read Line with Inlay Hints in the Command Palette, or <keybinding:editor.action.accessibleView>, opens the current line with its type and parameter hints in a read-only accessible view. Escape closes it and returns focus to the editor. Reading hints does not change the document.'),
						localize('limitIndicator.help', 'Language features limited in the status bar explains when color decorations or folding regions are capped for performance. Focus that entry and press Enter to open the related settings. Folder links inside the workspace reveal the folder in Explorer.'),
						localize('accessibility.editorContextMenu', 'Shift+F10 opens the editor context menu. Use arrow keys to choose an action or open the Peek and Copy As submenus, Enter to run it, and Escape to return to the editor. Navigation, rename and formatting actions appear when the current language supports them. Change All Occurrences selects matching text for editing.'),
						localize('accessibility.editorBreakpoints', '<keybinding:editor.debug.action.toggleBreakpoint> toggles a breakpoint on the current line. The glyph margin before the line numbers shows breakpoints and the paused debug position. Click an empty cell to add a breakpoint; Shift+click a breakpoint to enable or disable it. Use the Breakpoints view checkboxes for the same operation with the keyboard. Debug: Add Conditional Breakpoint, Debug: Add Logpoint, and Debug: Edit Breakpoint open an editor; Enter saves and Escape cancels. Alt+click opens the same editor from the glyph margin. Drag a breakpoint to another gutter line, or use Debug: Move Breakpoint to enter a line number. The gutter context menu offers the same actions.'),
						localize('accessibility.editorFormatting', 'When formatting a document, select a formatter or configure the default for the current language. Escape cancels selection and returns to the editor. Format on Type runs only after a declared trigger character when enabled.'),
						localize('accessibility.editorMinimap', 'The minimap is a visual overview of this document. Use Toggle Minimap in the Command Palette to show or hide it. Minimap settings control its size, automatic visibility and section headers. Use Go to Line or Go to Symbol for keyboard navigation to the same document content.'),
						localize('accessibility.editorNavigation', 'In reference Peek, arrow keys move between results, F4 and Shift+F4 cycle results, and F6 switches focus between the results and preview editor. Enter opens a result; F12 then cycles the saved results and Escape ends the cycle. Hierarchy trees use arrow keys to move and expand; the direction buttons choose callers, callees, supertypes or subtypes. Escape closes Peek.'),
						localize('accessibility.editorCodeActions', '<keybinding:editor.action.quickFix> opens code actions. An available code action also appears as a button beside the line. Refactor and Source Action menus show actions for that family. Rename uses Enter to submit and Escape to cancel; when preview is available, Ctrl+Enter or Command+Enter opens it.'),
						localize('accessibility.editorSaveRecovery', 'Save failures offer recovery actions in a dialog. Use Tab to choose Overwrite, Retry with administrator permission, Save As, or Revert when available, and Enter to run the selected action. Escape cancels and preserves your unsaved changes. Overwrite makes a read-only file writable; Revert discards unsaved changes.'),
						localize('url.trust.editorHelp', 'Manage Trusted Domains in the Command Palette opens a JSONC array of domain rules. Save to apply changes; remove rules to revoke trust. Invalid rules and stale saves are rejected. Untrusted web links ask before opening. Use Tab to choose Open, Copy, Configure Trusted Domains, or Cancel, Enter to select, and Escape to cancel.'),
						localize('accessibility.multiDiffFiles', 'In a multi-file comparison, file headers expand and collapse each comparison. Arrow keys move between headers. Binary files show a text-comparison-unavailable message and retain their file actions. Save saves modified writable files, including collapsed files. Closing the last view of an unsaved file offers Save, Discard, or Cancel.'),
						localize('accessibility.editorStatus', 'The status bar shows the active editor position, indentation, encoding, line endings, and language. Run Focus Status Bar in the Command Palette. Use the arrow keys to select an action, Home or End to select the first or last action, and Enter or Space to run it. Escape first focuses the status bar itself, then returns to the editor. Shift+F10 opens the status bar menu: toggle an entry or hide the current entry. Hidden entries stay hidden after restarting and can be restored from this menu. Indentation, encoding, line endings, and language actions open a picker; Escape cancels it. Reopen with Encoding suggests a detected encoding. Default encoding and automatic detection can be configured per language. Line ending changes can be undone.'),
						localize('accessibility.editorTabs', 'Focus an editor tab and press Shift+F10 to open its menu. Close this tab, other tabs in its group, tabs to its left or right, saved tabs in its group, all tabs in its group, or tabs in all groups. Bulk close actions keep pinned tabs; cancelling an unsaved-changes prompt stops closing. Closing tabs to the left or right is unavailable with multiple tabs selected. <keybinding:workbench.action.reopenClosedEditor> reopens the most recently closed tab. File tabs also offer Copy Path, Copy Relative Path, and Reveal in Explorer View. These file actions are unavailable for tabs without a file path. Move into New Window transfers the selected tabs; Copy into New Window keeps them open in both windows. Both actions are also available in the Command Palette. Use arrow keys to choose, Enter to run, and Escape to cancel and return to the tab.'),
						localize('accessibility.editorViews', '<keybinding:workbench.action.splitEditor> opens a second editor group. <keybinding:workbench.action.closeGroup> closes an empty editor group and returns focus to a remaining group. For files with multiple editor types, the selector at the end of the breadcrumbs lets you switch views. Markdown title actions open a preview or reopen the current tab as a preview.'),
						localize('accessibility.editorTitleMenu', 'The editor title More Actions menu lists open editors in that group, closes all or saved editors, toggles preview editors, locks the group, and opens editor settings. With multiple groups, Maximize Group hides the other groups; Unmaximize Group restores the layout. Use arrow keys to choose, Enter to run, and Escape to dismiss. Locking a group keeps unrelated files from opening in it. <keybinding:workbench.action.closeEditorsInGroup> closes all unpinned editors in the current group; <keybinding:workbench.action.closeUnmodifiedEditors> closes its saved editors. <keybinding:workbench.action.toggleMaximizeEditorGroup> maximizes or restores the group.'),
						localize('workbench.editor.emptyHelp', 'Empty editor groups offer Go to File, Search in Files, and Show All Commands. Use Tab to select an action and Enter or Space to run it. Shortcut hints follow your keybindings; actions remain available without a shortcut.'),
						localize('accessibility.editorPanel', 'Run Focus into Panel from the Command Palette to open the last active panel and move focus into it. Hide Panel closes it; Toggle Panel Visibility shows or hides it. Maximize Panel expands it, and Restore Editor Area restores the editor.'),
						localize('accessibility.editorAuxiliaryBar', 'The secondary side bar title offers Maximize Secondary Side Bar and Hide Secondary Side Bar. Use arrow keys in the toolbar and Enter to run an action. Restore Secondary Side Bar returns the previous layout. Hiding the side bar keeps its conversation and draft; Show Secondary Side Bar reopens it. These actions are also in the Command Palette.'),
						localize('accessibility.editorRegions', '<keybinding:workbench.action.focusNextPart> moves to the next visible Workbench part; <keybinding:workbench.action.focusPreviousPart> moves to the previous part. The Navigate to the View commands move by direction, visiting editor groups before leaving the editor area. Hidden parts are skipped. The primary side bar More Actions menu shows or hides individual views, moves the side bar, and changes the Activity Bar position or size. The last visible view cannot be hidden.'),
						localize('accessibility.activityBarAutoHide', 'Auto Hide Activity Bar in Settings hides each side bar view switcher at the top or bottom when at most one container at that location has active views. View commands remain available in the Command Palette. If the switcher has focus when it hides, focus moves to the current view.'),
						editor.getOption(EditorOption.tabFocusMode)
							? localize('accessibility.editorTabFocus', 'Tab moves focus to the next control. <keybinding:editor.action.toggleTabFocusMode> changes this behavior.')
							: localize('accessibility.editorTabIndent', 'Tab inserts indentation. <keybinding:editor.action.toggleTabFocusMode> lets Tab move focus to the next control.'),
						localize('dropOrPaste.accessibilityHelp', '<keybinding:editor.action.pasteAs> lets you choose a paste action. <keybinding:editor.action.pasteAsText> pastes plain text. After pasting or dropping content, <keybinding:editor.changePasteType> or <keybinding:editor.changeDropType> opens the available actions and preferred-action settings. Escape returns to the editor.'),
						localize('accessibility.editorMode', '<keybinding:editor.action.toggleScreenReaderAccessibilityMode> toggles screen reader optimization.'),
						localize('scrollLocking.help', '<keybinding:workbench.action.toggleLockedScrolling> toggles locked scrolling across visible editors, preserving their relative positions. Bind Hold Locked Scrolling Across Editors to temporarily toggle it while a shortcut is held. The Scrolling Locked status bar entry disables it. Releasing the shortcut or leaving the window restores the previous state.'),
						localize('accessibility.editorCompactWindow', 'In a separate editor window, Toggle Window Compact Mode hides the editor tabs and status bar, shows the current window title in the center, and moves editor actions to the title bar. Turn Off Compact Mode in the title bar restores them. Opening another editor or splitting the group also restores navigation.'),
						localize('accessibility.editorCloseHelp', 'Escape closes this help and returns focus to the editor. <keybinding:editor.action.accessibleViewDisableHint> stops announcing the editor help hint.'),
					].join('\n\n'),
					() => editor.focus(),
					AccessibilityVerbositySettingId.Editor,
				);
			},
		}));
		this._register(codeEditors.onCodeEditorAdd(editor => this.trackEditor(editor)));
		this._register(codeEditors.onCodeEditorRemove(editor => this.editors.deleteAndDispose(editor)));
		for (const editor of codeEditors.listCodeEditors()) {
			this.trackEditor(editor);
		}
	}

	private trackEditor(editor: ICodeEditor): void {
		if (editor.isSimpleWidget || editor.getOption(EditorOption.inDiffEditor)) {
			return;
		}
		this.editors.set(editor, editor.onDidFocusEditorText(() => {
			if (!this.accessibility.isScreenReaderOptimized()) {
				return;
			}
			const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Editor);
			if (hint) {
				this.accessibility.status(hint);
			}
		}));
	}
}
