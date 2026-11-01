import './media/mediaPreview.css';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPanes, registerBuiltinEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { SideBySideEditor } from '../../../browser/parts/editor/sideBySideEditor.js';
import { isResourceDiffEditorInput } from '../../../common/editor.js';
import { IMAGE_PREVIEW_EDITOR_ID, AUDIO_PREVIEW_EDITOR_ID, VIDEO_PREVIEW_EDITOR_ID, ImagePreviewConfiguration, isImageResource } from '../common/mediaPreview.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { CopyImageAction, SelectImageZoomLevelAction } from './mediaPreviewActions.js';
import { MediaPreviewStatusBarContribution } from './mediaPreviewStatusBar.js';
import { MediaPreview } from './mediaPreview.js';
import { ImagePreviewEditorInput } from './imagePreviewEditorInput.js';
import { MediaPlayerEditorInput, isMediaPlayerKind } from './mediaPlayerEditorInput.js';
import { EditorInputSerializers, requireRecord, requireSerializedEditorInput } from '../../../services/editor/common/editorInputSerializer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IFileService, type IFileRenameEvent } from '../../../../platform/files/common/files.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { URI } from '../../../../base/common/uri.js';

/** Media panes own decoding; this contribution follows successful filesystem resource moves. */
class MediaPreviewResourceTracker extends Disposable {
	private updating: Promise<void> = Promise.resolve();
	constructor(
		@IFileService files: IFileService,
		@IEditorPartsService private readonly editors: IEditorPartsService,
	) {
		super();
		this._register(files.onDidRenameFile(event => {
			this.updating = this.updating.then(() => this.followRename(event)).catch(onUnexpectedError);
		}));
	}

	private async followRename(event: IFileRenameEvent): Promise<void> {
		if (this.isDisposed) { return; }
		for (const group of this.editors.groups) {
			for (const editor of group.editors) {
				if (this.isDisposed) { return; }
				const input = editor.input;
				if (!(input instanceof ImagePreviewEditorInput) && !(input instanceof MediaPlayerEditorInput)) { continue; }
				if (!extUri.isEqualOrParent(input.resource, event.source) || !group.inputs.includes(input)) { continue; }
				const relative = input.resource.path.slice(event.source.path.length).replace(/^\//, '');
				const resource = relative ? URI.joinPath(event.target, relative) : event.target;
				await group.replaceEditor(input, input.rename(resource));
			}
		}
	}
}

registerAction2(CopyImageAction);
registerAction2(SelectImageZoomLevelAction);
registerWorkbenchContribution('workbench.contrib.mediaPreviewStatusBar', WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(MediaPreviewStatusBarContribution));
registerWorkbenchContribution('workbench.contrib.mediaPreviewResources', WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(MediaPreviewResourceTracker));

EditorInputSerializers.registerStatic({
	typeId: ImagePreviewEditorInput.ID,
	canSerialize: input => input instanceof ImagePreviewEditorInput,
	serialize: (input, registry) => {
		if (!(input instanceof ImagePreviewEditorInput)) { throw new TypeError('Image serialization requires an image preview input'); }
		return registry.serialize(input.toUntyped());
	},
	deserialize: (value, registry) => new ImagePreviewEditorInput(registry.deserialize(requireSerializedEditorInput(value, 'serialized image resource'))),
});

EditorInputSerializers.registerStatic({
	typeId: MediaPlayerEditorInput.typeId,
	canSerialize: input => input instanceof MediaPlayerEditorInput,
	serialize: (input, registry) => {
		if (!(input instanceof MediaPlayerEditorInput)) { throw new TypeError('Media serialization requires a media player input'); }
		return { kind: input.kind, source: registry.serialize(input.toUntyped()) };
	},
	deserialize: (value, registry) => {
		const record = requireRecord(value, 'serialized media player input');
		if (!isMediaPlayerKind(record.kind)) { throw new TypeError('Invalid serialized media player kind'); }
		return new MediaPlayerEditorInput(record.kind, registry.deserialize(requireSerializedEditorInput(record.source, 'serialized media resource')));
	},
});

EditorPanes.registerStatic({
	id: IMAGE_PREVIEW_EDITOR_ID,
	get name(): string { return localize('media.image.preview', 'Image preview'); },
	resourceEditor: true,
	createInput: input => isResourceDiffEditorInput(input) || input instanceof ImagePreviewEditorInput ? input : new ImagePreviewEditorInput(input),
	canOpen: input => {
		const supported = isResourceDiffEditorInput(input)
			? isImageResource(input.original) && isImageResource(input.modified)
			: isImageResource(input);
		return supported ? EditorPaneMatch.Default : EditorPaneMatch.None;
	},
	create: options => {
		const instantiation = options.instantiationService;
		if (!instantiation) throw new Error('Image preview requires Workbench instantiation services');
		if (options.input && isResourceDiffEditorInput(options.input)) {
			return instantiation.createInstance(SideBySideEditor, IMAGE_PREVIEW_EDITOR_ID,
				instantiation.createInstance(ImagePreviewEditor), instantiation.createInstance(ImagePreviewEditor));
		}
		return instantiation.createInstance(ImagePreviewEditor);
	},
});

for (const kind of ['audio', 'video'] as const) {
	registerBuiltinEditorPane('ash.media-preview', kind === 'audio' ? AUDIO_PREVIEW_EDITOR_ID : VIDEO_PREVIEW_EDITOR_ID, (options, name) => {
		if (!options.instantiationService) { throw new Error('Media preview requires Workbench instantiation services'); }
		return options.instantiationService.createInstance(MediaPreview, kind, name);
	}, { createInput: input => input instanceof MediaPlayerEditorInput && input.kind === kind ? input : new MediaPlayerEditorInput(kind, input) });
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: ImagePreviewConfiguration.showImageInfo,
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	setting: {
		valueType: 'boolean',
		get title(): string { return localize('media.image.showInfo.title', 'Show image information'); },
		get description(): string { return localize('media.image.showInfo.description', 'Show image dimensions and file size in the status bar. The image zoom control is always shown.'); },
	},
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('mediaPreview.invalidBoolean', '{0} must be true or false.', ImagePreviewConfiguration.showImageInfo));
		}
		return value;
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<'fit' | 'actualSize'>({
	key: ImagePreviewConfiguration.defaultZoom,
	defaultValue: 'fit',
	scope: ConfigurationScope.WINDOW,
	setting: {
		valueType: 'select',
		get title(): string { return localize('media.image.defaultZoom.title', 'Default image zoom'); },
		get description(): string { return localize('media.image.defaultZoom.description', 'Zoom for images without a saved view. Changes also apply to open image previews.'); },
		get options(): readonly { value: 'fit' | 'actualSize'; label: string; }[] {
			return [
				{ value: 'fit' as const, label: localize('media.image.defaultZoom.fit', 'fit') },
				{ value: 'actualSize' as const, label: localize('media.image.defaultZoom.raw', 'raw') },
			];
		},
	},
	parse: value => {
		if (value !== 'fit' && value !== 'actualSize') throw new TypeError(localize('media.image.defaultZoom.invalid', 'Image zoom must be fit or actualSize.'));
		return value;
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: ImagePreviewConfiguration.fitToWindowPercentage,
	defaultValue: 100,
	scope: ConfigurationScope.WINDOW,
	setting: {
		valueType: 'number', minimum: 10, maximum: 100,
		get title(): string { return localize('media.image.fitPercentage.title', 'Fit area percentage'); },
		get description(): string { return localize('media.image.fitPercentage.description', 'Percentage of the image viewport used by Fit to window. Images are enlarged or reduced to fit, keep their aspect ratio, and are never cropped.'); },
	},
	parse: value => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 10 || value > 100) {
			throw new TypeError(localize('media.image.fitPercentage.invalid', 'Fit area percentage must be between 10 and 100.'));
		}
		return value;
	},
});

for (const preference of [
	{
		key: 'mediaPreview.video.autoPlay',
		get title(): string { return localize('mediaPreview.video.autoPlay.title', 'Automatically play videos'); },
		get description(): string { return localize('mediaPreview.video.autoPlay.description', 'Automatically start playback when opening a video preview.'); },
	},
	{
		key: 'mediaPreview.video.loop',
		get title(): string { return localize('mediaPreview.video.loop.title', 'Loop videos'); },
		get description(): string { return localize('mediaPreview.video.loop.description', 'Restart videos after playback reaches the end.'); },
	},
]) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key: preference.key,
		defaultValue: false,
		scope: ConfigurationScope.WINDOW,
		setting: {
			valueType: 'boolean',
			get title(): string { return preference.title; },
			get description(): string { return preference.description; },
		},
		parse: value => {
			if (typeof value !== 'boolean') throw new TypeError(localize('mediaPreview.invalidBoolean', '{0} must be true or false.', preference.key));
			return value;
		},
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
					? localize('media.playback.help', 'Audio and video preview\nPress Space on the player to play or pause. Use Tab to reach playback controls for seeking, volume and fullscreen where available. Use Save As to copy the original media bytes to another file. If loading fails, choose Retry to read the file again or Open as read-only text to inspect its contents. Git LFS pointers are reported without starting playback. <keybinding:editor.action.accessibleView> reads the filename, file size, duration and playback state; it does not transcribe audio or describe video. Video autoplay and looping can be configured in Settings under Media Preview. Audio starts only when you play it. Each split has an independent player, playback position, volume, mute setting and playback speed. Splitting, moving, saving a copy and restarting restore those settings. Renaming or moving a file in Explorer updates its open media tabs. Playback stops when you switch away from the preview. File changes reload the preview. Closing the tab stops playback and releases its resources; the original file stays intact.')
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
			const preview = ImagePreviewEditor.getFocused(focused);
			if (!preview) { return undefined; }
			return new AccessibleContentProvider(
				AccessibleViewProviderId.ImagePreview,
				{ type },
				() => type === AccessibleViewType.Help
					? localize('media.image.help', 'Image preview\nPress Plus or Minus to zoom, 0 to fit the image to the window, or 1 to show its actual size. Once focused, click the image to zoom in, use a modifier with the scroll wheel, or pinch on a trackpad. Choose Copy image or use the system copy shortcut to copy it. Right click or press Shift+F10 for the image menu. Activate the dimensions and file size in the status bar to view image information, copy dimensions or full information, or hide image information. Press Escape in the details to close and return to the status bar. The status bar has a separate image zoom button; activate it to select Fit to window or a zoom level. Show image information in Settings controls whether dimensions and file size are displayed beside it. Zoom and scroll position are preserved when splitting or moving the image to another editor group, saving a copy, or reopening the image. Use Save As to copy the original image bytes to another file. If loading fails, use Retry or Open as read-only text in the error message. Git LFS pointers are reported without decoding them. Default zoom and fit area percentage can be configured in Settings under Features > Media Preview. Focus Image viewport and use arrow keys to scroll enlarged images. <keybinding:editor.action.accessibleView> reads the filename, dimensions, format and zoom; it does not describe the picture. File changes refresh this preview. Closing the tab releases its preview resources; the original file stays intact.')
					: preview.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.ImagePreview,
			);
		},
	});
}
