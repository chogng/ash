import './standaloneColorPicker/standaloneColorPickerActions.js';
import './color.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { ColorService } from '../common/languageColors.js';
import { ColorDetector } from './colorDetector.js';
import { ColorPickerController } from './colorPickerController.js';
import { ColorPickerWidget } from './colorPickerWidget.js';
import { HoverParticipantRegistry } from '../../hover/browser/hoverTypes.js';
import { HoverColorPickerParticipant } from './hoverColorPicker/hoverColorPickerParticipant.js';

HoverParticipantRegistry.register(HoverColorPickerParticipant);

registerEditorContribution({
	id: 'editor.contrib.colorPicker',
	install: context => {
		if (context.kind !== 'text') { return; }
		const service = new ColorService(context.model, context.languageFeaturesService.colorProvider, context.model.uri, context.onLanguageError);
		const targetWindow = context.controller.element.ownerDocument.defaultView;
		if (!targetWindow) { throw new Error('Color picker requires an attached browser window'); }
		const detector = context.register(new ColorDetector(context.editor, context.model, service, targetWindow, context.onLanguageError));
		return context.instantiationService.createInstance(ColorPickerController, context.controller.element, context.editor, context.view, service, detector, context.onLanguageError);
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ColorPicker,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Color picker accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('colorPicker.verbosityTitle', 'Color picker accessibility help'),
		description: localize('colorPicker.verbosityDescription', 'Announce how to open accessibility help when the color picker receives focus.'),
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 130,
		name: `editorColorPicker${type}`,
		getProvider: accessor => {
			for (const editor of accessor.get(ICodeEditorService).listCodeEditors()) {
				const focused = editor.getDomNode()?.ownerDocument.activeElement;
				if (!isHTMLElement(focused)) { continue; }
				const widget = ColorPickerWidget.getFocused(focused);
				if (!widget) { continue; }
				return new AccessibleContentProvider(
					AccessibleViewProviderId.ColorPicker,
					{ type },
					() => type === AccessibleViewType.View ? widget.getAccessibleContent() : localize('colorPicker.help', 'Color picker\nUse Left and Right to change saturation, Up and Down to change brightness. Hold Shift for larger steps. Tab moves through hue, opacity, format and color values. Hex, RGB, CSS, HSL and HSB control how you enter a color. Document color format controls the text written to the document. Restore original color resets the selection. In a hover, releasing a drag, changing a color with the keyboard or choosing a document format writes one undoable edit. The standalone picker previews changes until Apply or <keybinding:editor.action.insertColorWithStandaloneColorPicker> commits them. Enter in a color value field confirms that value. Escape or Close dismisses the picker and returns focus to the editor; committed hover edits remain in the document and can be undone. Opening the picker at an existing color edits that color; elsewhere it replaces the selected text or inserts at the cursor. <keybinding:editor.action.accessibleView> reads the current color and document value.'),
					() => { if (focused.isConnected) { focused.focus(); } },
					AccessibilityVerbositySettingId.ColorPicker,
				);
			}
			return undefined;
		},
	});
}
