import { IChatResponseResourceFileSystemProvider, type IChatResourceAssociation } from '../../../common/widget/chatResponseResourceFileSystemProvider.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import './media/chatMarkdownPart.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { createObjectUrl, triggerDownload } from '../../../../../../base/browser/fileAccess.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { decodeBase64 } from '../../../../../../base/common/buffer.js';
import { getMediaMime, Mimes } from '../../../../../../base/common/mime.js';
import { htmlAttributeEncodeValue } from '../../../../../../base/common/strings.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { localize } from '../../../../../../nls.js';
import { IAgentThreadService } from '../../../../../../platform/agentHost/common/agentService.js';
import { type ChatContentPart } from '../../../../../../platform/agentHost/common/agent.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { IWebviewService, type IWebviewElement } from '../../../../webview/browser/webview.js';
import { EditorPanes } from '../../../../../browser/editor.js';
import type { IEditorPane } from '../../../../../common/editor.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatImageReveal, type IChatImageRevealOrigin } from '../../attachments/chatImageReveal.js';
import { copyChatImage } from '../../chatImageActions.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ImagePreviewPopup } from '../../../../mediaPreview/browser/imagePreviewPopup.js';
import { ImageAttachmentWidget } from '../../attachments/chatAttachmentWidgets.js';
import { getChatFileIcon } from '../chatMarkdownRichContent.js';
import { renderChatChartDocument } from './chatChartDocument.js';

/** A provider-owned resource; only its reader knows authentication or protocol coordinates. */
export interface IChatAttachmentResource {
	readonly type: 'resource';
	readonly resource: URI;
	readonly name: string;
	readonly presentation: 'image' | 'audio' | 'video' | 'document' | 'html' | 'chart';
	readonly mimeType?: string;
	readonly frameOrigin?: string;
}

export interface IChatAttachmentsContentPartOptions {
	readonly ownerDocument: Document;
	readonly variables: readonly (ChatContentPart | IChatAttachmentResource)[];
	readonly source?: IChatListItem['attachmentSource'];
	readonly readResource?: (resource: URI, signal: AbortSignal) => Promise<Blob>;
	readonly imagePresentation?: 'inline';
	readonly thumbnailImages?: boolean;
	readonly imageReveal?: IChatImageRevealOrigin;
}

type MediaPart = Exclude<ChatContentPart, { readonly type: 'text' | 'artifact'; }> | IChatAttachmentResource;

type ImagePart = Extract<MediaPart, { type: 'imageAttachment' | 'imageUrl' | 'resource'; }>;

function isImage(part: MediaPart): part is ImagePart {
	return part.type === 'imageAttachment' || part.type === 'imageUrl' || part.type === 'resource' && part.presentation === 'image';
}

/** One media row owns its request, playback and decoded URL for exactly this transcript entry. */
class MediaRow extends Disposable {
	public readonly element: HTMLElement;
	public readonly status: HTMLElement;
	public readonly loadButton: HTMLButtonElement;
	public readonly openButton: HTMLButtonElement;
	public readonly association = this._register(new MutableDisposable<IChatResourceAssociation>());
	public readonly media: HTMLElement;
	public readonly downloadButton: HTMLButtonElement;
	public readonly copyButton: HTMLButtonElement | undefined;
	public blob: Blob | undefined;
	public readonly preview = this._register(new MutableDisposable<IWebviewElement | IEditorPane>());
	public readonly objectUrl = this._register(new MutableDisposable());
	public readonly imageReveal = this._register(new MutableDisposable<ChatImageReveal>());
	public readonly imageContainer: HTMLElement | undefined;
	public readonly imageTrigger: HTMLButtonElement | undefined;
	public readonly imagePreview = this._register(new MutableDisposable<DisposableStore>());
	public readonly resources = this._register(new DisposableStore());
	public readonly controller = new AbortController();
	public loaded = false;
	public loading = false;

	public setStatus(message: string): void {
		this.status.textContent = this.part.type === 'resource' ? localize('chat.resource.loadStatus', '{0}: {1}', this.part.name, message) : message;
	}

	constructor(document: Document, public readonly part: MediaPart, public readonly source: IChatListItem['attachmentSource'], public readonly index: number, inlineImage: boolean, useImagePopup: boolean) {
		super();
		this.element = h(document, 'figure');
		this.element.className = 'ash-chat-media';
		this.element.tabIndex = -1;
		this.status = h(document, 'figcaption');
		const image = isImage(part);
		const presentation = part.type === 'resource' ? part.presentation : image ? 'image' : 'audio';
		const label = image ? localize('chat.media.image', 'Image') : localize('chat.media.audio', 'Audio');
		this.status.textContent = part.type === 'resource' ? part.name : part.type === 'imageAttachment'
			? localize('chat.media.imageDimensions', 'Image ({0} × {1})', part.attachment.width, part.attachment.height)
			: part.type === 'audioAttachment'
				? localize('chat.media.audioDuration', 'Audio ({0} seconds)', Math.ceil(part.attachment.durationMs / 1000)) : label;
		this.media = h(document, image ? 'img' : presentation === 'audio' || presentation === 'video' ? presentation : 'div');
		this.media.setAttribute('aria-label', this.status.textContent);
		if (image) {
			const preview = this.media as HTMLImageElement;
			preview.alt = this.status.textContent;
			preview.loading = inlineImage || useImagePopup ? 'eager' : 'lazy';
			if (inlineImage) {
				this.imageContainer = h(document, 'div');
				this.imageContainer.className = 'ash-chat-image-frame';
				this.imageContainer.append(preview);
			}
		} else if (presentation === 'audio' || presentation === 'video') {
			const player = this.media as HTMLMediaElement;
			player.controls = true;
			player.preload = 'none';
		}
		this.media.hidden = true;
		this.loadButton = h(document, 'button');
		this.loadButton.type = 'button';
		this.loadButton.textContent = part.type === 'resource' ? localize('chat.resource.preview', 'Preview') : image ? localize('chat.media.loadImage', 'Load image') : localize('chat.media.loadAudio', 'Load audio');
		this.openButton = h(document, 'button');
		this.openButton.type = 'button';
		this.openButton.textContent = part.type === 'resource' ? localize('chat.resource.open', 'Open resource') : image ? localize('chat.media.openImage', 'Open image') : localize('chat.media.openAudio', 'Open audio');
		this.openButton.hidden = true;
		this.downloadButton = h(document, 'button');
		this.downloadButton.type = 'button';
		this.downloadButton.textContent = localize('chat.resource.download', 'Download');
		this.downloadButton.hidden = true;
		const content = this.imageContainer ?? this.media;
		if (image && useImagePopup) {
			this.imageTrigger = h(document, 'button', {
				className: 'ash-chat-media-preview-trigger',
				properties: { type: 'button', hidden: true },
				attributes: { 'aria-label': localize('chat.context.previewImage', 'Preview {0}', this.status.textContent) },
			}, content);
		}
		this.element.append(this.status, this.loadButton, this.imageTrigger ?? content);
		if (!this.imageTrigger) this.element.append(this.openButton);
		this.element.append(this.downloadButton);
		if (image) {
			this.copyButton = h(document, 'button');
			this.copyButton.type = 'button';
			this.copyButton.textContent = localize('chat.media.copyImage', 'Copy image');
			this.copyButton.hidden = true;
			this.element.append(this.copyButton);
		}
		this._register(toDisposable(() => {
			this.controller.abort();
			if (this.media instanceof document.defaultView!.HTMLMediaElement && this.loaded) {
				(this.media as HTMLMediaElement).pause();
				this.media.removeAttribute('src');
				(this.media as HTMLMediaElement).load();
			} else this.media.removeAttribute('src');
			this.element.remove();
		}));
	}
}

type Thumbnail = DisposableStore & {
	readonly part: ImagePart;
	readonly source: IChatListItem['attachmentSource'];
	readonly widget: ImageAttachmentWidget;
};

/** Presents transcript resources with shared loading, preview, editor and disposal ownership. */
export class ChatAttachmentsContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly rows = this._register(new DisposableMap<number, MediaRow>());
	private readonly thumbnails = this._register(new DisposableMap<number, Thumbnail>());
	private readonly thumbnailList: HTMLElement | undefined;
	private readonly useImagePopup: boolean;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(private readonly options: IChatAttachmentsContentPartOptions, @IAgentThreadService private readonly threads: IAgentThreadService, @IChatResponseResourceFileSystemProvider private readonly files: IChatResponseResourceFileSystemProvider, @IEditorService private readonly editors: IEditorService, @IWebviewService private readonly webviews: IWebviewService, @IInstantiationService private readonly instantiation: IInstantiationService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-media-attachments';
		this.useImagePopup = contextKeys.getValue(ChatContextKeys.imagePreviewPresentation.key) === 'popup';
		if (this.useImagePopup && options.thumbnailImages) {
			this.thumbnailList = h(options.ownerDocument, 'div', { className: 'ash-chat-sent-image-thumbnails' });
			this.domNode.append(this.thumbnailList);
		}
		this._register(toDisposable(() => this.domNode.remove()));
		this.updateVariables(options.variables, options.source);
	}

	public updateVariables(variables: IChatAttachmentsContentPartOptions['variables'], source?: IChatListItem['attachmentSource']): void {
		const indices = new Set(variables.flatMap((part, index) => part.type === 'text' || part.type === 'artifact' ? [] : [index]));
		let changed = false;
		for (const [index] of this.rows) if (!indices.has(index)) { this.rows.deleteAndDispose(index); changed = true; }
		for (const [index] of this.thumbnails) if (!indices.has(index)) { this.thumbnails.deleteAndDispose(index); changed = true; }
		let next: ChildNode | null = this.thumbnailList ? this.thumbnailList.nextSibling : this.domNode.firstChild;
		let nextThumbnail = this.thumbnailList?.firstChild ?? null;
		for (const [index, part] of variables.entries()) {
			if (part.type === 'text' || part.type === 'artifact') continue;
			if (this.thumbnailList && isImage(part)) {
				if (this.rows.get(index)?.element === next) next = next?.nextSibling ?? null;
				this.rows.deleteAndDispose(index);
				let thumbnail = this.thumbnails.get(index);
				if (!thumbnail || !sameMedia(thumbnail.part, part) || !sameSource(thumbnail.source, source)) {
					if (thumbnail?.widget.element === nextThumbnail) nextThumbnail = nextThumbnail?.nextSibling ?? null;
					thumbnail = this.thumbnails.set(index, this.createThumbnail(part, source, index, this.thumbnailList));
					changed = true;
				}
				if (thumbnail.widget.element !== nextThumbnail) this.thumbnailList.insertBefore(thumbnail.widget.element, nextThumbnail);
				nextThumbnail = thumbnail.widget.element.nextSibling;
				continue;
			}
			if (this.thumbnails.get(index)?.widget.element === nextThumbnail) nextThumbnail = nextThumbnail?.nextSibling ?? null;
			this.thumbnails.deleteAndDispose(index);
			let row = this.rows.get(index);
			if (!row || !sameMedia(row.part, part) || !sameSource(row.source, source)) {
				changed = true;
				if (row?.element === next) next = row.element.nextSibling;
				row = this.rows.set(index, new MediaRow(this.options.ownerDocument, part, source, index, this.options.imagePresentation === 'inline', this.useImagePopup));
				const current = row;
				const origin = this.options.imageReveal;
				if (current.imageContainer && origin && !origin.container.hidden && ![...this.rows].some(([, candidate]) => candidate !== current && !!candidate.imageReveal.value)) {
					current.imageReveal.value = this.instantiation.createInstance(ChatImageReveal, current.imageContainer, current.media as HTMLImageElement, origin);
				}
				// The row owns listeners even when a later update replaces it at the same content index.
				row.resources.add(addDisposableListener(row.loadButton, 'click', () => { void this.load(current); }));
				row.resources.add(addDisposableListener(row.openButton, 'click', () => { void this.open(current); }));
				if (row.imageTrigger) row.resources.add(addDisposableListener(row.imageTrigger, 'click', () => this.showImage(current)));
				row.resources.add(addDisposableListener(row.downloadButton, 'click', () => { if (current.blob) triggerDownload(current.blob, mediaName(current.part, !!current.imageTrigger), this.options.ownerDocument); }));
				if (row.copyButton) {
					const button = row.copyButton;
					const image = row.media as HTMLImageElement;
					row.resources.add(addDisposableListener(button, 'click', async () => {
						if (button.hidden || button.getAttribute('aria-disabled') === 'true') return;
						button.setAttribute('aria-disabled', 'true');
						try {
							await this.instantiation.invokeFunction(copyChatImage, image, current.blob);
						} catch (error) {
							if (!current.isDisposed) {
								this.instantiation.invokeFunction(accessor => accessor.get(INotificationService).error(
									localize('chat.media.copyFailed', 'Could not copy this image: {0}', String(error))));
							}
						} finally {
							if (!current.isDisposed) button.removeAttribute('aria-disabled');
						}
					}));
				}
				row.resources.add(addDisposableListener(row.media, 'load', event => {
					current.imageReveal.value?.reveal(event.timeStamp);
					if (current.imageTrigger) {
						current.imageTrigger.hidden = false;
						current.downloadButton.hidden = !current.blob;
					}
					if (current.copyButton) {
						const image = current.media as HTMLImageElement;
						current.copyButton.hidden = !image.naturalWidth || !/^(?:blob:|data:image\/)/u.test(image.currentSrc || image.src);
					}
					if (current.imageContainer && current.association.value) {
						current.openButton.hidden = false;
						current.downloadButton.hidden = false;
					}
					this._onDidChangeHeight.fire();
				}));
				row.resources.add(addDisposableListener(row.media, 'loadedmetadata', () => this._onDidChangeHeight.fire()));
				row.resources.add(addDisposableListener(row.media, 'error', () => {
					current.imageReveal.clear();
					if (current.imageTrigger) current.imageTrigger.hidden = true;
					if (current.copyButton) current.copyButton.hidden = true;
					if (current.imageContainer) {
						current.media.hidden = true;
						current.openButton.hidden = current.downloadButton.hidden = true;
					}
					current.setStatus(localize('chat.media.unavailable', 'This media could not be loaded.'));
					this._onDidChangeHeight.fire();
				}));
				if (part.type === 'imageUrl' || part.type === 'audioUrl') {
					const url = safeMediaUrl(part, this.useImagePopup);
					if (url) this.reveal(row, url);
					else {
						row.imageReveal.clear();
						row.loadButton.hidden = true;
						row.status.textContent = localize('chat.media.unavailable', 'This media could not be loaded.');
					}
				}
				if (part.type === 'resource') { void this.load(current); }
				if (part.type === 'imageAttachment' && this.options.imagePresentation === 'inline') { void this.load(current); }
			}
			// Avoid disconnecting a retained audio player or the user's focused media row.
			if (row.element !== next) { this.domNode.insertBefore(row.element, next); changed = true; }
			next = row.element.nextSibling;
		}
		if (this.thumbnailList) this.thumbnailList.hidden = this.thumbnails.size === 0;
		if (changed) this._onDidChangeHeight.fire();
	}

	private createThumbnail(part: ImagePart, source: IChatListItem['attachmentSource'], index: number, container: HTMLElement): Thumbnail {
		const lifetime = new DisposableStore();
		const controller = new AbortController();
		lifetime.add(toDisposable(() => controller.abort()));
		const widget = lifetime.add(this.instantiation.createInstance(ImageAttachmentWidget, {
			id: String(index), name: mediaName(part, true),
			resolve: async () => {
				const signal = controller.signal;
				let content: Blob | undefined;
				if (part.type === 'resource') {
					try {
						content = await this.readResource(part, signal);
					} catch (error) {
						if (signal.aborted || !isPublicMediaResource(part.resource)) throw error;
						return { content: part.resource.toString() };
					}
				} else if (part.type === 'imageAttachment' && source) {
					const { sessionId, threadId, itemId, kind } = source;
					const data = await this.threads.readAttachment({ sessionId, threadId, itemId, contentIndex: kind === 'toolResult' ? index : undefined }, signal);
					content = new Blob([new Uint8Array(data.bytes)], { type: data.mimeType });
				} else if (part.type === 'imageUrl') {
					return { content: safeMediaUrl(part, true) };
				}
				return { content: content?.type.startsWith('image/') ? content : undefined };
			},
		}, { imagePresentation: 'thumbnail', allowProviderImageUrls: true, retryOnFailure: true, supportsDeletion: false, shouldFocusClearButton: false }, container));
		lifetime.add(widget.onDidResolvePreview(() => this._onDidChangeHeight.fire()));
		return Object.assign(lifetime, { part, source, widget });
	}

	private showImage(row: MediaRow): void {
		const trigger = row.imageTrigger;
		if (!trigger || trigger.hidden || row.isDisposed) return;
		const src = (row.media as HTMLImageElement).src;
		if (!src) return;
		const lifetime = new DisposableStore();
		row.imagePreview.value = lifetime;
		trigger.focus({ preventScroll: true });
		const preview = this.instantiation.createInstance(ImagePreviewPopup, {
			name: mediaName(row.part, true), blob: row.blob, url: src,
		}, trigger, lifetime, undefined, () => {
			if (row.imagePreview.value === lifetime) row.imagePreview.clear();
		});
		if (!preview.show()) row.imagePreview.clear();
	}

	public setVisible(visible: boolean): void {
		if (visible) return;
		for (const [, thumbnail] of this.thumbnails) thumbnail.widget.closePreview();
		for (const [, row] of this.rows) {
			row.imageReveal.clear();
			row.imagePreview.clear();
			if (row.loaded && row.media.matches('audio,video')) (row.media as HTMLMediaElement).pause();
		}
	}

	get isPlaying(): boolean {
		for (const [, row] of this.rows) {
			if (!row.loaded || !row.media.matches('audio,video')) continue;
			const media = row.media as HTMLMediaElement;
			if (!media.paused && !media.ended) return true;
		}
		return false;
	}

	private async load(row: MediaRow): Promise<void> {
		if (row.loaded || row.loading || row.isDisposed) return;
		if (row.part.type === 'resource') { await this.loadResource(row); return; }
		if (!row.source) {
			row.imageReveal.clear();
			row.status.textContent = localize('chat.media.noThread', 'Open this media in its original conversation.');
			return;
		}
		row.loading = true;
		row.loadButton.setAttribute('aria-disabled', 'true');
		row.element.setAttribute('aria-busy', 'true');
		try {
			// Presentation sources may be structurally typed Thread snapshots. Only send resource coordinates.
			const { sessionId, threadId, itemId, kind } = row.source;
			const data = await this.threads.readAttachment({ sessionId, threadId, itemId, contentIndex: kind === 'toolResult' ? row.index : undefined }, row.controller.signal);
			if (row.isDisposed || this.isDisposed) return;
			const expected = row.part.type === 'imageAttachment' ? 'image/' : 'audio/';
			if (!data.mimeType.startsWith(expected)) throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
			const ownerWindow = this.options.ownerDocument.defaultView;
			if (!ownerWindow) return;
			row.blob = new Blob([new Uint8Array(data.bytes)], { type: data.mimeType });
			const objectUrl = createObjectUrl(ownerWindow, row.blob);
			row.objectUrl.value = objectUrl.registration;
			if (!row.imageTrigger && (row.part.type === 'imageAttachment' || row.part.type === 'audioAttachment')) {
				const name = `${row.part.type === 'imageAttachment' ? localize('chat.media.image', 'Image') : localize('chat.media.audio', 'Audio')}.${row.part.attachment.mediaType}`;
				row.association.value = this.files.associate(data.bytes, { id: JSON.stringify([row.source, row.index, row.part.type, row.part.attachment.contentDigest]), name });
				row.openButton.hidden = this.options.imagePresentation === 'inline';
			}
			const focused = this.options.ownerDocument.activeElement === row.loadButton;
			this.reveal(row, objectUrl.url.toString());
			if (focused) row.element.focus();
		} catch (error) {
			row.imageReveal.clear();
			if (!row.isDisposed && !this.isDisposed) row.setStatus(localize('chat.media.loadFailed', 'Could not load this media: {0}', String(error)));
		} finally {
			if (!row.isDisposed) {
				row.loading = false;
				row.loadButton.removeAttribute('aria-disabled');
				row.element.removeAttribute('aria-busy');
				this._onDidChangeHeight.fire();
			}
		}
	}

	private async readResource(part: IChatAttachmentResource, signal: AbortSignal): Promise<Blob | undefined> {
		if (part.frameOrigin && part.resource.scheme === 'https') {
			const url = new URL(part.resource.toString());
			if (url.origin !== part.frameOrigin || url.username || url.password) {
				throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
			}
			const html = `<iframe src="${htmlAttributeEncodeValue(url.href)}" title="${htmlAttributeEncodeValue(part.name)}" style="border:0;width:100%;height:100vh" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`;
			return new Blob([html], { type: 'text/html' });
		}
		const blob = await this.options.readResource?.(part.resource, signal);
		if (blob && part.presentation === 'chart') {
			const html = renderChatChartDocument(part.name, await blob.text());
			if (!html) throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
			return new Blob([html], { type: 'text/html' });
		}
		const inferred = this.useImagePopup && part.presentation === 'image' && (!part.mimeType || part.mimeType === 'application/octet-stream')
			? getMediaMime(part.name) : part.mimeType;
		return blob && inferred && (!blob.type || blob.type === 'application/octet-stream')
			? new Blob([blob], { type: inferred }) : blob;
	}

	private async loadResource(row: MediaRow): Promise<void> {
		if (row.part.type !== 'resource' || !this.options.readResource) return;
		row.loading = true;
		row.element.setAttribute('aria-busy', 'true');
		try {
			const blob = await this.readResource(row.part, row.controller.signal);
			if (!blob || row.isDisposed || this.isDisposed) return;
			row.blob = blob;
			const mime = blob.type.split(';')[0]!.toLowerCase();
			if (row.imageTrigger) {
				if (!mime.startsWith('image/')) throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
				const url = createObjectUrl(this.options.ownerDocument.defaultView!, blob);
				row.objectUrl.value = url.registration;
				const focused = this.options.ownerDocument.activeElement === row.loadButton;
				this.reveal(row, url.url.toString());
				if (focused) row.element.focus();
				return;
			}
			row.downloadButton.hidden = false;
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (row.isDisposed || this.isDisposed) return;
			row.association.value = this.files.associate(bytes, { name: row.part.name });
			row.openButton.hidden = false;
			if (['image', 'audio', 'video'].includes(row.part.presentation) && !mime.startsWith(row.part.presentation + '/')) {
				throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
			}
			if (row.part.presentation === 'html' || mime === 'text/html') {
				const view = this.webviews.createWebviewElement({
					title: row.part.name, options: {}, contentOptions: {
						allowScripts: true, localResourceRoots: [],
						...(row.part.frameOrigin ? { contentSecurityPolicy: { connectDomains: [], resourceDomains: [], frameDomains: [row.part.frameOrigin], baseUriDomains: [] } } : {}),
					}
				});
				row.preview.value = view;
				view.setHtml(new TextDecoder().decode(bytes));
				view.mountTo(row.media, getWindow(row.element));
				row.media.classList.add('ash-chat-html-preview');
			} else if (row.part.presentation === 'document') {
				if (/^(?:text\/|application\/(?:json|xml))/u.test(mime)) {
					const text = h(row.element.ownerDocument, 'pre');
					text.textContent = new TextDecoder().decode(bytes);
					row.media.append(text);
				} else {
					const input = { resource: row.association.value!.resource, contentType: mime, readOnly: true, initialBytes: bytes };
					const descriptor = EditorPanes.getEditorPanesForInput(input).find(pane => pane.resourceEditor);
					if (!descriptor) {
						this.showFileDownload(row, row.part.name, blob);
						return;
					}
					const pane = await descriptor.create({ input, instantiationService: this.instantiation });
					if (row.isDisposed || this.isDisposed) { pane.dispose(); return; }
					row.preview.value = pane;
					row.media.classList.add('ash-chat-resource-preview');
					pane.create(row.media);
					await pane.setInput(input, row.controller.signal);
					if (row.isDisposed || this.isDisposed) { row.preview.clear(); return; }
				}
			} else {
				const url = createObjectUrl(this.options.ownerDocument.defaultView!, blob);
				row.objectUrl.value = url.registration;
				row.media.setAttribute('src', url.url.toString());
			}
			row.loaded = true;
			row.media.hidden = false;
			const focused = this.options.ownerDocument.activeElement === row.loadButton;
			row.loadButton.hidden = true;
			if (focused) row.element.focus();
		} catch (error) {
			// Public media can be embedded by the browser even when its server does
			// not opt into CORS reads. Authenticated providers still use their reader.
			if (!row.isDisposed && !this.isDisposed && row.part.type === 'resource' && row.media.matches('img,audio,video') && isPublicMediaResource(row.part.resource)) {
				this.reveal(row, row.part.resource.toString());
				row.status.textContent = row.part.name;
				return;
			}
			if (!row.isDisposed && !this.isDisposed) row.setStatus(localize('chat.media.loadFailed', 'Could not load this media: {0}', String(error)));
		} finally {
			if (!row.isDisposed) { row.loading = false; row.element.removeAttribute('aria-busy'); this._onDidChangeHeight.fire(); }
		}
	}

	private showFileDownload(row: MediaRow, name: string, blob: Blob): void {
		const document = row.element.ownerDocument;
		const restoreFocus = row.element.contains(document.activeElement);
		// A copied link can also be navigated to. Serve it as download-only bytes.
		const { url, registration } = createObjectUrl(getWindow(row.element), new Blob([blob], { type: Mimes.binary }));
		row.objectUrl.value = registration;
		row.association.clear();
		const label = localize('chat.resource.downloadFile', 'Download {0}', name);
		const icon = h(document, 'span', { className: 'ash-chat-file-link-icon' });
		appendIcon(getChatFileIcon(name), icon);
		const link = h(document, 'a', {
			className: 'ash-chat-file-download',
			properties: { href: url.href, download: name, title: label },
			attributes: { 'aria-label': label },
		}, icon, name);
		row.element.replaceChildren(link);
		row.loaded = true;
		if (restoreFocus) link.focus();
	}

	private async open(row: MediaRow): Promise<void> {
		if (row.isDisposed || this.isDisposed || !row.association.value || row.openButton.disabled) return;
		row.openButton.disabled = true;
		try {
			if (row.media.matches('audio,video')) (row.media as HTMLMediaElement).pause();
			await this.editors.openEditor({ resource: row.association.value.resource, readOnly: true });
		} catch (error) {
			if (!row.isDisposed && !this.isDisposed) row.status.textContent = localize('chat.media.openFailed', 'Could not open this media: {0}', String(error));
		} finally {
			if (!row.isDisposed) row.openButton.disabled = false;
		}
	}

	private reveal(row: MediaRow, url: string): void {
		if ((this.options.imagePresentation === 'inline' || row.imageTrigger) && row.part.type === 'imageUrl' && url.startsWith('data:image/')) {
			try {
				const separator = url.indexOf(',');
				const mimeType = url.slice(5, url.indexOf(';'));
				const bytes = decodeBase64(url.slice(separator + 1)).buffer;
				row.blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
				if (!row.imageTrigger) row.association.value = this.files.associate(bytes, { name: mediaName(row.part) });
			} catch {
				row.imageReveal.clear();
				row.setStatus(localize('chat.media.unavailable', 'This media could not be loaded.'));
				return;
			}
		}
		row.loaded = true;
		row.media.setAttribute('src', url);
		row.media.hidden = false;
		row.loadButton.hidden = true;
	}
}

function isPublicMediaResource(resource: URI): boolean {
	return ['http', 'https'].includes(resource.scheme) && !resource.authority.includes('@');
}

function mediaName(part: MediaPart, includeSvg = false): string {
	if (part.type === 'resource') return part.name;
	const extension = part.type === 'imageAttachment' || part.type === 'audioAttachment' ? part.attachment.mediaType
		: includeSvg && (part.url.startsWith('data:image/svg+xml;') || /\.svg(?:[?#]|$)/iu.test(part.url)) ? 'svg'
			: part.url.startsWith('data:') ? part.url.slice(5, part.url.indexOf(';')).split('/')[1] ?? 'png' : 'png';
	return `${localize('chat.media.image', 'Image')}.${extension}`;
}

function sameSource(left: IChatListItem['attachmentSource'], right: IChatListItem['attachmentSource']): boolean {
	return left?.sessionId === right?.sessionId && left?.threadId === right?.threadId && left?.itemId === right?.itemId && left?.kind === right?.kind;
}

function sameMedia(left: MediaPart, right: MediaPart): boolean {
	if (left.type !== right.type) return false;
	if (left.type === 'resource') return right.type === 'resource' && left.resource.toString() === right.resource.toString() && left.name === right.name && left.presentation === right.presentation && left.mimeType === right.mimeType && left.frameOrigin === right.frameOrigin;
	if ('url' in left) return 'url' in right && left.url === right.url;
	if (!('attachment' in right) || left.attachment.contentDigest !== right.attachment.contentDigest
		|| left.attachment.mediaType !== right.attachment.mediaType || left.attachment.encodedBytes !== right.attachment.encodedBytes) return false;
	return left.type === 'imageAttachment'
		? right.type === 'imageAttachment' && left.attachment.width === right.attachment.width && left.attachment.height === right.attachment.height
		: right.type === 'audioAttachment' && left.attachment.durationMs === right.attachment.durationMs;
}

function safeMediaUrl(part: Extract<MediaPart, { readonly type: 'imageUrl' | 'audioUrl'; }>, allowSvg: boolean): string | undefined {
	try {
		const url = new URL(part.url);
		if (url.username || url.password) return undefined;
		if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
		if (part.type === 'imageUrl' && allowSvg && /^data:image\/svg\+xml;base64,/iu.test(part.url)) return part.url;
		const allowed = part.type === 'imageUrl' ? /^data:image\/(png|jpeg|gif|webp);base64,/iu : /^data:audio\/(wav|mpeg|mp4|webm|ogg);base64,/iu;
		return allowed.test(part.url) ? part.url : undefined;
	} catch { return undefined; }
}
