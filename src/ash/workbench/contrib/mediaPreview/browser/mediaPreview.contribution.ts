import './media/imagePreview.css';
import './media/mediaPreview.css';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerBuiltinEditorPane } from '../../../browser/editor.js';
import { IMAGE_PREVIEW_ID, ImagePreview } from './imagePreview.js';
import { AUDIO_PREVIEW_ID, VIDEO_PREVIEW_ID, MediaPreview } from './mediaPreview.js';

registerBuiltinEditorPane('ash.media-preview', IMAGE_PREVIEW_ID, options => {
	if (!options.instantiationService) { throw new Error('Image preview requires Workbench instantiation services'); }
	return options.instantiationService.createInstance(ImagePreview);
});

for (const kind of ['audio', 'video'] as const) {
	registerBuiltinEditorPane('ash.media-preview', kind === 'audio' ? AUDIO_PREVIEW_ID : VIDEO_PREVIEW_ID, (options, name) => {
		if (!options.instantiationService) { throw new Error('Media preview requires Workbench instantiation services'); }
		return options.instantiationService.createInstance(MediaPreview, kind, name);
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.MediaPreview,
	defaultValue: true,
	setting: {
		valueType: 'boolean',
		get title(): string { return localize('media.playback.verbosityTitle', 'Media preview accessibility help'); },
		get description(): string { return localize('media.playback.verbosityDescription', 'Announce how to open accessibility help when an audio or video preview receives focus.'); },
	},
	parse: value => {
		if (typeof value !== 'boolean') { throw new TypeError('Media preview accessibility verbosity must be boolean'); }
		return value;
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `mediaPreview.${type}`,
		when: ContextKeyExpr.has('mediaPreviewFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const preview = MediaPreview.getFocused(focused);
			if (!preview) { return undefined; }
			return new AccessibleContentProvider(
				AccessibleViewProviderId.MediaPreview,
				{ type },
				() => type === AccessibleViewType.Help
					? localize('media.playback.help', 'Audio and video preview\nPress Space on the player to play or pause. Use Tab to reach playback controls for seeking, volume and fullscreen where available. <keybinding:editor.action.accessibleView> reads the filename, file size, duration and playback state; it does not transcribe audio or describe video. Playback stops when you switch away from the preview. File changes reload the preview. Closing the tab stops playback and releases its resources; the original file stays intact.')
					: preview.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.MediaPreview,
			);
		},
	});
}

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
