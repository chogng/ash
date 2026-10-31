import { localize } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { ThemeEditor, ThemeEditorFocused } from './themeEditor.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ThemeEditor,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean')
			throw new TypeError(
				localize('themeEditor.invalidVerbosity', 'Theme Editor accessibility verbosity must be a boolean.'),
			);
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize('themeEditor.verbosityTitle', 'Theme Editor accessibility help');
		},
		get description() {
			return localize(
				'themeEditor.verbosityDescription',
				'Announce how to open accessibility help when Theme Editor receives focus.',
			);
		},
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		name: 'themeEditor',
		priority: 110,
		type,
		when: ThemeEditorFocused.isEqualTo(true),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPartsService).activePane;
			if (!(pane instanceof ThemeEditor)) return undefined;
			const focused = pane.getContainer()?.ownerDocument.activeElement as HTMLElement | null;
			return new AccessibleContentProvider(
				AccessibleViewProviderId.ThemeEditor,
				{ type },
				() =>
					type === AccessibleViewType.View
						? pane.getAccessibleContent()
						: localize(
							'themeEditor.colorInputHelp',
							'Each color row uses one shared control: a swatch followed by either a token reference or the Hex value and opacity (%). Press Enter or leave the field to confirm an edit; Escape restores the current value.',
						) +
						' ' +
						localize(
							'themeEditor.listHelp',
							'Tab and Shift+Tab visit every color in expanded categories. Accessible View reads all colors in those categories, including colors outside the visible area.',
						) +
						' ' +
						localize(
							'themeEditor.currentThemeHelp',
							'Open Theme Editor opens the currently applied theme. Installed themes open as editable drafts. Adjust colors to preview them, then save to name and apply your own theme. The installed source is never overwritten. In development, built-in themes open their checkout source for editing.',
						) +
						' ' +
						localize(
							'themeEditor.sourceHelp',
							'Use the editor type selector in the breadcrumbs to switch between Theme Editor and Text Editor. Both editors share the same document and undo history. Use the standard Undo and Redo commands and <keybinding:workbench.action.files.save> to save. Use <keybinding:workbench.action.files.saveAs> to create a user theme copy while Theme Editor is active.',
						) +
						' ' +
						localize(
							'themeEditor.scmPreviewHelp',
							'Opening Theme Editor hides the primary sidebar, secondary sidebar and panel. In the IDE preview, choose SCM History to inspect branch lanes, merges and local and remote reference colors. Color edits update the sample graph immediately. Use the graph tree with the arrow keys to explore commits and their changed files.',
						) +
						' ' +
						localize(
							'themeEditor.help',
							'Theme Editor opens as a tab in the current window. Use Move to New Window from the editor tab menu to detach it. Closing a detached window returns its document to the main window. Close the editor tab to save or discard unsaved changes. User themes and development themes open their source files. Installed themes open independent, unsaved drafts. Reopening the same theme reveals its existing editor tab in the current window. Adjust installed themes directly in the preview. Saving asks for a name and applies a user theme copy without overwriting the installed source. Colors and the source text editor share one document and undo history. Enter or Space on a category expands or collapses it. Search opens matching categories; clearing search restores the previous layout. Above the preview, choose IDE or Agent Window, then choose the Interface, Code or Diff scene. In each tab list, use Left and Right to focus a tab and Enter or Space to select it. The color list follows the selected window and scene. All colors includes colors from every scene. Each scene remembers its search, category expansion and scroll position. All previews share the edited theme document and undo history. Code focuses on TypeScript and JSON samples using the real editor and syntax highlighting. Syntax highlighting includes editor token colors and existing semantic token rules; editing a semantic foreground preserves its other styles. Diff shows added and removed lines and changes within a line using the real comparison editor. Color edits update its highlights immediately. Previews load on first use. Switching preserves sample interactions until the editor closes. Agent Window navigation and its draft composer remain local to the preview. The isolated preview on the right is an embedded desktop window with a title bar, fixed sample files, a read-only code editor, a read-only terminal color sample and a status bar. The terminal sample does not execute commands. It scales to fit the canvas. The title bar search opens sample files; its layout buttons toggle the sidebar and bottom panel. Preview interactions never change project files or the main window theme. Use Tab and Shift+Tab to move between controls; the preview frame has its own keyboard navigation. Enter on a color name opens the source text editor at that value. Open a swatch with Enter or Space. In the color picker, Left and Right adjust saturation, Up and Down adjust brightness, and Shift increases the step. Tab moves through hue, opacity, format and color values. Enter confirms a color value. <keybinding:editor.action.accessibleView> reads the focused color or preview sample. Escape or Close dismisses the picker and returns to the swatch. Token references appear beside the color swatch in place of the Hex and opacity fields. Linked to identifies a direct design token reference; Derived from identifies a transformed color. Hover a reference to read its source and resolved color. Open the swatch to set a custom color. Enter or Space on a token link clears search, expands its category and focuses the source color. Editing a linked color creates an override; Reset removes the override and restores its default relationship. Invalid JSON retains the last valid preview. Draft changes are saved automatically for recovery. Use <keybinding:workbench.action.files.save> to save the theme document. The editor tab indicates unsaved changes and returns to its normal close icon after saving. Saving the currently applied theme refreshes the workbench; saving another theme does not select it. Press Escape to close this help and return to the previous control.',
						),
				() => {
					if (focused?.isConnected) focused.focus();
					else pane.focus();
				},
				AccessibilityVerbositySettingId.ThemeEditor,
			);
		},
	});
}
