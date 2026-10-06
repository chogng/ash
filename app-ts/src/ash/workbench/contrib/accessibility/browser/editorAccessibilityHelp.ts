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
						localize('accessibility.editorRead', 'Use arrow keys to read text, Shift with arrow keys to select, and Ctrl+C or Command+C to copy. <keybinding:actions.find> opens Find.'),
						localize('accessibility.editorContextMenu', 'Shift+F10 opens the editor context menu. Use arrow keys to choose an action or open the Peek and Copy As submenus, Enter to run it, and Escape to return to the editor. Navigation, rename and formatting actions appear when the current language supports them. Change All Occurrences selects matching text for editing.'),
						localize('accessibility.editorNavigation', 'In reference Peek, arrow keys move between results, F4 and Shift+F4 cycle results, and F6 switches focus between the results and preview editor. Enter opens a result; F12 then cycles the saved results and Escape ends the cycle. Hierarchy trees use arrow keys to move and expand; the direction buttons choose callers, callees, supertypes or subtypes. Escape closes Peek.'),
						localize('accessibility.editorCodeActions', '<keybinding:editor.action.quickFix> opens code actions. An available code action also appears as a button beside the line. Refactor and Source Action menus show actions for that family. Rename uses Enter to submit and Escape to cancel; when preview is available, Ctrl+Enter or Command+Enter opens it.'),
						localize('accessibility.editorViews', '<keybinding:workbench.action.splitEditor> opens a second editor group. For files with multiple editor types, the selector at the end of the breadcrumbs lets you switch views. Markdown title actions open a preview or reopen the current tab as a preview.'),
						editor.getOption(EditorOption.tabFocusMode)
							? localize('accessibility.editorTabFocus', 'Tab moves focus to the next control. <keybinding:editor.action.toggleTabFocusMode> changes this behavior.')
							: localize('accessibility.editorTabIndent', 'Tab inserts indentation. <keybinding:editor.action.toggleTabFocusMode> lets Tab move focus to the next control.'),
						localize('dropOrPaste.accessibilityHelp', '<keybinding:editor.action.pasteAs> lets you choose a paste action. <keybinding:editor.action.pasteAsText> pastes plain text. After pasting or dropping content, <keybinding:editor.changePasteType> or <keybinding:editor.changeDropType> opens the available actions and preferred-action settings. Escape returns to the editor.'),
						localize('accessibility.editorMode', '<keybinding:editor.action.toggleScreenReaderAccessibilityMode> toggles screen reader optimization.'),
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
