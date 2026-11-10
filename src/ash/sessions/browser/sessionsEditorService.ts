import { getActiveElement, getWindow, isHTMLElement } from '../../base/browser/dom.js';
import { ContextView } from '../../base/browser/ui/contextview/contextview.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { basename } from '../../base/common/resources.js';
import { localize } from '../../nls.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import type { IEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { isResourceDiffEditorInput, type IResourceEditorInput } from '../../workbench/common/editor.js';
import { ImagePreviewPopup } from '../../workbench/contrib/mediaPreview/browser/imagePreviewPopup.js';
import { getImageResourceMime, IMAGE_PREVIEW_EDITOR_ID, isGitLfsPointer } from '../../workbench/contrib/mediaPreview/common/mediaPreview.js';
import { BrowserEditorService } from '../../workbench/services/editor/browser/browserEditorService.js';
import type { EditorOpenOptions, EditorOpenTarget } from '../../workbench/services/editor/common/editorService.js';

/** Agent Window resource navigation uses the shared popup for ordinary images. */
export class SessionsEditorService extends BrowserEditorService {
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		editorPart: IEditorPart,
		@IFileService private readonly files: IFileService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(editorPart);
	}

	override async openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void> {
		if (options?.onlyWhenEmpty && (this.preview.value || this.visibleEditors.length > 0)) return;
		if (!options?.inactive && !isResourceDiffEditorInput(input)
			&& input.resource.scheme !== Schemas.untitled && input.initialText === undefined
			&& (!input.editorId || input.editorId === IMAGE_PREVIEW_EDITOR_ID)
			&& (!options?.preferredEditorId || options.preferredEditorId === IMAGE_PREVIEW_EDITOR_ID)) {
			const mimeType = getImageResourceMime(input);
			if (mimeType) {
				await this.openImage(input, mimeType, options);
				return;
			}
		}
		if (!options?.inactive && !options?.preserveFocus) this.preview.clear();
		return super.openEditor(input, options, target);
	}

	private async openImage(input: IResourceEditorInput, mimeType: string, options: EditorOpenOptions | undefined): Promise<void> {
		const lifetime = new DisposableStore();
		this.preview.value = lifetime;
		const document = this.contextViews.container.ownerDocument;
		const window = getWindow(document);
		const trigger = getActiveElement(document);
		const revision = ContextView.getPopupRevision(document);
		const close = () => {
			if (this.preview.value === lifetime) this.preview.clear();
		};
		try {
			const bytes = input.initialBytes ?? (await this.files.readFileBytes(input.resource)).bytes;
			if (lifetime.isDisposed || ContextView.getPopupRevision(document) !== revision) { close(); return; }
			if (isGitLfsPointer(input.resource, bytes)) {
				throw new Error(localize('mediaPreview.gitLfsPointer', 'This Git revision contains a Git LFS pointer instead of media content. Open it as text to inspect the pointer.'));
			}
			const name = input.label ?? basename(input.resource);
			const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
			const url = window.URL.createObjectURL(blob);
			lifetime.add(toDisposable(() => window.URL.revokeObjectURL(url)));
			const anchor = isHTMLElement(trigger) && trigger !== document.body && trigger.isConnected
				? trigger : { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0 };
			const popup = this.instantiation.createInstance(ImagePreviewPopup, { name, url, blob }, anchor, lifetime, undefined, close);
			if (!popup.show()) close();
		} catch (error) {
			if (lifetime.isDisposed) return;
			close();
			if (options?.ignoreError) throw error;
			this.notifications.error(localize('media.image.loadFailed', 'Could not load image: {0}', error instanceof Error ? error.message : String(error)));
		}
	}
}
