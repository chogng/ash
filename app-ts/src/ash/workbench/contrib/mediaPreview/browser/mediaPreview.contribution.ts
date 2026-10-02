import './media/imagePreview.css';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { IMAGE_PREVIEW_ID, ImagePreview, matchImagePreview } from './imagePreview.js';

registerEditorPane({
	id: IMAGE_PREVIEW_ID,
	get name(): string { return localize('media.image.preview', 'Image preview'); },
	canOpen: matchImagePreview,
	create: options => {
		if (!options.instantiationService) { throw new Error('Image preview requires Workbench instantiation services'); }
		return options.instantiationService.createInstance(ImagePreview);
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ImagePreview,
	defaultValue: true,
	setting: {
		valueType: 'boolean',
		get title(): string { return localize('media.image.verbosityTitle', 'Image preview accessibility help'); },
		get description(): string { return localize('media.image.verbosityDescription', 'Announce how to open accessibility help when the image preview receives focus.'); },
	},
	parse: value => {
		if (typeof value !== 'boolean') { throw new TypeError('Image preview accessibility verbosity must be boolean'); }
		return value;
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `imagePreview.${type}`,
		when: ContextKeyExpr.has('imagePreviewFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const preview = ImagePreview.getFocused(focused);
			if (!preview) { return undefined; }
			return new AccessibleContentProvider(
				AccessibleViewProviderId.ImagePreview,
				{ type },
				() => type === AccessibleViewType.Help
					? localize('media.image.help', 'Image preview\nPress Plus or Minus to zoom, 0 to fit the image to the window, or 1 to show its actual size. Use Tab to reach the toolbar, then Left and Right to choose an action and Enter to activate it. Focus Image viewport and use arrow keys to scroll enlarged images. <keybinding:editor.action.accessibleView> reads the filename, dimensions, format and zoom; it does not describe the picture. File changes refresh this preview. Closing the tab releases its preview resources; the original file stays intact.')
					: preview.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.ImagePreview,
			);
		},
	});
}
