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
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('themeEditor.help', 'Theme Editor runs in an auxiliary window while the main window previews your theme. Use Tab and Shift+Tab to move between search, category, color controls and JSON. Enter on a color name locates its JSON value. Edit a hex color, choose a color, or use arrow keys on its opacity slider. Reset removes the file override and restores inherited colors. The color panel and JSON share undo and redo. Invalid JSON retains the last valid preview. Live preview toggles temporary colors without saving. Save writes the current theme; Save as creates a user theme copy. Use <keybinding:workbench.action.files.save> to save. Close this editor or turn off Live preview to restore the configured theme. Press Escape to close this help and return to the previous control.'),
				() => { if (focused?.isConnected) focused.focus(); else pane.focus(); }, AccessibilityVerbositySettingId.ThemeEditor);
		},
	});
}
