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
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('themeEditor.windowPinHelp', 'The Pin Window button on the right of the window title bar keeps this Theme Editor window above other windows. Use Tab to focus it and Enter or Space to toggle; the button reports whether the window is pinned.') + ' ' + localize('themeEditor.help', 'Theme Editor runs in an auxiliary window. Colors and Theme JSON on the left share one document and undo history. Enter or Space on a category expands or collapses it. Search opens matching categories; clearing search restores the previous layout. Above the preview, use Left and Right to focus Workbench or Agent Window and Enter or Space to switch windows. Both previews share the edited theme. Switching resets sample interactions. Agent Window navigation and its draft composer remain local to the preview. The isolated preview on the right is an embedded desktop window with a title bar, sample files, an editable code editor, a terminal and a status bar. It scales to fit the canvas. The title bar search opens sample files; its layout buttons toggle the sidebar and bottom panel. Preview interactions never change project files or the main window theme. Use Tab and Shift+Tab to move between controls; the preview frame has its own keyboard navigation. Enter on a color name opens Theme JSON at that value. Open a swatch with Enter or Space. In the color picker, Left and Right adjust saturation, Up and Down adjust brightness, and Shift increases the step. Tab moves through hue, opacity, format and color values. Enter confirms a color value. <keybinding:editor.action.accessibleView> reads the focused color or preview sample. Escape or Close dismisses the picker and returns to the swatch. Linked to identifies a direct design token reference; Derived from identifies a transformed color. Enter or Space on a token link clears search, expands its category and focuses the source color. Editing a linked color creates an override; Reset removes the override and restores its default relationship. Invalid JSON retains the last valid preview. Draft changes are saved automatically for recovery. The title bar has Undo and Redo buttons on the left. Save and Apply on the right saves a valid theme and switches the main window. Its adjacent dropdown contains Save as to create a copy and Save to write without applying. Use Left and Right to move between the primary button and dropdown, and Enter or Space to activate. Use <keybinding:workbench.action.files.save> to save without applying. Closing the editor leaves the main window unchanged. Press Escape to close this help and return to the previous control.'),
				() => { if (focused?.isConnected) focused.focus(); else pane.focus(); }, AccessibilityVerbositySettingId.ThemeEditor);
		},
	});
}
