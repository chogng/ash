import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { ThemeEditor, ThemeEditorFocused } from './themeEditor.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ThemeEditor,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('themeEditor.invalidVerbosity', 'Theme Editor accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('themeEditor.verbosityTitle', 'Theme Editor accessibility help'); },
		get description() { return localize('themeEditor.verbosityDescription', 'Announce how to open accessibility help when Theme Editor receives focus.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		name: 'themeEditor', priority: 110, type, when: ThemeEditorFocused.isEqualTo(true),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPartsService).activePane;
			if (!(pane instanceof ThemeEditor)) return undefined;
			const focused = pane.getContainer()?.ownerDocument.activeElement as HTMLElement | null;
			return new AccessibleContentProvider(AccessibleViewProviderId.ThemeEditor, { type },
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('themeEditor.colorInputHelp', 'Each color row uses one shared control: the swatch and Hex value are on the left, and opacity (%) is on the right. Press Enter or leave the field to confirm an edit; Escape restores the current value.') + ' ' + localize('themeEditor.listHelp', 'Tab and Shift+Tab visit every color in expanded categories. Accessible View reads all colors in those categories, including colors outside the visible area.') + ' ' + localize('themeEditor.themePickerHelp', 'Open Theme in the editor toolbar opens a searchable list containing only themes. Use Up and Down to browse, Enter to open a theme in an editor tab, and Escape to cancel. Other theme tabs keep their unsaved changes. The workbench theme changes only with Save and Apply.') + ' ' + localize('themeEditor.sourceHelp', 'Use Open Theme (JSON) in the editor toolbar to edit the current theme source. In JSON, the same button becomes Open Theme (UI) and returns to Colors. Both views keep the same unsaved edits, selection and undo history. Enter or Space activates the button and focuses the selected view.') + ' ' + localize('themeEditor.help', 'Theme Editor opens as a tab in the current window. Use Move to New Window from the editor tab menu to detach it. Closing a detached window returns its document to the main window. Close the editor tab to save or discard unsaved changes. Opening a theme shows its original source file without creating a copy or unsaved changes. Reopening the same theme reveals its existing editor tab in the current window. Packaged sources without a writable file are read-only; use Save as to create an editable user theme. Colors and Theme JSON on the left share one document and undo history. Enter or Space on a category expands or collapses it. Search opens matching categories; clearing search restores the previous layout. Above the preview, use Left and Right to focus Workbench, Diff or Agent Window and Enter or Space to switch previews. All previews share the edited theme. Diff shows added and removed lines and changes within a line using the real comparison editor. Color edits update its highlights immediately. Switching resets sample interactions. Agent Window navigation and its draft composer remain local to the preview. The isolated preview on the right is an embedded desktop window with a title bar, sample files, an editable code editor, a read-only terminal color sample and a status bar. The terminal sample does not execute commands. It scales to fit the canvas. The title bar search opens sample files; its layout buttons toggle the sidebar and bottom panel. Preview interactions never change project files or the main window theme. Use Tab and Shift+Tab to move between controls; the preview frame has its own keyboard navigation. Enter on a color name opens Theme JSON at that value. Open a swatch with Enter or Space. In the color picker, Left and Right adjust saturation, Up and Down adjust brightness, and Shift increases the step. Tab moves through hue, opacity, format and color values. Enter confirms a color value. <keybinding:editor.action.accessibleView> reads the focused color or preview sample. Escape or Close dismisses the picker and returns to the swatch. Linked to identifies a direct design token reference; Derived from identifies a transformed color. Enter or Space on a token link clears search, expands its category and focuses the source color. Editing a linked color creates an override; Reset removes the override and restores its default relationship. Invalid JSON retains the last valid preview. Draft changes are saved automatically for recovery. The editor toolbar has Undo and Redo buttons. Save and Apply saves a valid theme and applies it to the workbench. Its adjacent dropdown contains Save as to create a copy and Save to write without applying. Use Left and Right to move between the primary button and dropdown, and Enter or Space to activate. Use <keybinding:workbench.action.files.save> to save without applying. Closing the editor leaves the main window unchanged. Press Escape to close this help and return to the previous control.'),
				() => { if (focused?.isConnected) focused.focus(); else pane.focus(); }, AccessibilityVerbositySettingId.ThemeEditor);
		},
	});
}
