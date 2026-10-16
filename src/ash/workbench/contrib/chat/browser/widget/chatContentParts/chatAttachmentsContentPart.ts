import { IChatResponseResourceFileSystemProvider, type IChatResourceAssociation } from '../../../common/widget/chatResponseResourceFileSystemProvider.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import './media/chatMarkdownPart.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { createObjectUrl, triggerDownload } from '../../../../../../base/browser/fileAccess.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IAgentThreadService, type ChatContentPart } from '../../../../../../platform/agentHost/common/agentService.js';
import type { IChatListItem } from '../chatListItems.js';
import { IWebviewService, type IWebviewElement } from '../../../../webview/browser/webview.js';
import { PdfJsRenderer, type IPdfRenderResult } from '../../../../pdf/browser/pdfRenderer.js';

/** A provider-owned resource; only its reader knows authentication or protocol coordinates. */
export interface IChatAttachmentResource {
	readonly type: 'resource';
	readonly resource: URI;
	readonly name: string;
	readonly presentation: 'image' | 'audio' | 'video' | 'document' | 'html';
	readonly mimeType?: string;
	readonly frameOrigin?: string;
}

export interface IChatAttachmentsContentPartOptions {
	readonly ownerDocument: Document;
	readonly variables: readonly (ChatContentPart | IChatAttachmentResource)[];
	readonly source?: IChatListItem['attachmentSource'];
	readonly readResource?: (resource: URI, signal: AbortSignal) => Promise<Blob>;
}

type MediaPart = Exclude<ChatContentPart, { readonly type: 'text' | 'artifact'; }> | IChatAttachmentResource;

/** One media row owns its request, playback and decoded URL for exactly this transcript entry. */
class MediaRow extends Disposable {
	public readonly element: HTMLElement;
	public readonly status: HTMLElement;
	public readonly loadButton: HTMLButtonElement;
	public readonly openButton: HTMLButtonElement;
	public readonly association = this._register(new MutableDisposable<IChatResourceAssociation>());
	public readonly media: HTMLElement;
	public readonly downloadButton: HTMLButtonElement;
	public blob: Blob | undefined;
	public readonly preview = this._register(new MutableDisposable<IWebviewElement | IPdfRenderResult>());
	public readonly objectUrl = this._register(new MutableDisposable());
	public readonly resources = this._register(new DisposableStore());
	public readonly controller = new AbortController();
	public loaded = false;
	public loading = false;

	public setStatus(message: string): void {
		this.status.textContent = this.part.type === 'resource' ? localize('chat.resource.loadStatus', '{0}: {1}', this.part.name, message) : message;
	}

	constructor(document: Document, public readonly part: MediaPart, public readonly source: IChatListItem['attachmentSource'], public readonly index: number) {
		super();
		this.element = h(document, 'figure');
		this.element.className = 'ash-chat-media';
		this.element.tabIndex = -1;
		this.status = h(document, 'figcaption');
		const image = part.type === 'imageAttachment' || part.type === 'imageUrl' || part.type === 'resource' && part.presentation === 'image';
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
			preview.loading = 'lazy';
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
		this.element.append(this.status, this.loadButton, this.media, this.openButton, this.downloadButton);
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

/** Presents transcript resources with shared loading, preview, editor and disposal ownership. */
export class ChatAttachmentsContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly rows = this._register(new DisposableMap<number, MediaRow>());
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(private readonly options: IChatAttachmentsContentPartOptions, @IAgentThreadService private readonly threads: IAgentThreadService, @IChatResponseResourceFileSystemProvider private readonly files: IChatResponseResourceFileSystemProvider, @IEditorService private readonly editors: IEditorService, @IWebviewService private readonly webviews: IWebviewService) {
		super();
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-media-attachments';
		this._register(toDisposable(() => this.domNode.remove()));
		this.updateVariables(options.variables, options.source);
	}

	public updateVariables(variables: IChatAttachmentsContentPartOptions['variables'], source?: IChatListItem['attachmentSource']): void {
		const indices = new Set(variables.flatMap((part, index) => part.type === 'text' || part.type === 'artifact' ? [] : [index]));
		let changed = false;
		for (const [index] of this.rows) if (!indices.has(index)) { this.rows.deleteAndDispose(index); changed = true; }
		let next: ChildNode | null = this.domNode.firstChild;
		for (const [index, part] of variables.entries()) {
			if (part.type === 'text' || part.type === 'artifact') continue;
			let row = this.rows.get(index);
			if (!row || !sameMedia(row.part, part) || !sameSource(row.source, source)) {
				changed = true;
				if (row?.element === next) next = row.element.nextSibling;
				row = this.rows.set(index, new MediaRow(this.options.ownerDocument, part, source, index));
				const current = row;
				// The row owns listeners even when a later update replaces it at the same content index.
				row.resources.add(addDisposableListener(row.loadButton, 'click', () => { void this.load(current); }));
				row.resources.add(addDisposableListener(row.openButton, 'click', () => { void this.open(current); }));
				row.resources.add(addDisposableListener(row.downloadButton, 'click', () => { if (current.blob && current.part.type === 'resource') triggerDownload(current.blob, current.part.name, this.options.ownerDocument); }));
				row.resources.add(addDisposableListener(row.media, 'load', () => this._onDidChangeHeight.fire()));
				row.resources.add(addDisposableListener(row.media, 'loadedmetadata', () => this._onDidChangeHeight.fire()));
				row.resources.add(addDisposableListener(row.media, 'error', () => {
					current.setStatus(localize('chat.media.unavailable', 'This media could not be loaded.'));
					this._onDidChangeHeight.fire();
				}));
				if (part.type === 'imageUrl' || part.type === 'audioUrl') {
					const url = safeMediaUrl(part);
					if (url) this.reveal(row, url);
					else {
						row.loadButton.hidden = true;
						row.status.textContent = localize('chat.media.unavailable', 'This media could not be loaded.');
					}
				}
				if (part.type === 'resource') { void this.load(current); }
			}
			// Avoid disconnecting a retained audio player or the user's focused media row.
			if (row.element !== next) { this.domNode.insertBefore(row.element, next); changed = true; }
			next = row.element.nextSibling;
		}
		if (changed) this._onDidChangeHeight.fire();
	}

	public setVisible(visible: boolean): void {
		if (visible) return;
		for (const [, row] of this.rows) if (row.loaded && row.media.matches('audio,video')) (row.media as HTMLMediaElement).pause();
	}

	private async load(row: MediaRow): Promise<void> {
		if (row.loaded || row.loading || row.isDisposed) return;
		if (row.part.type === 'resource') { await this.loadResource(row); return; }
		if (!row.source) {
			row.status.textContent = localize('chat.media.noThread', 'Open this media in its original conversation.');
			return;
		}
		row.loading = true;
		row.loadButton.setAttribute('aria-disabled', 'true');
		row.element.setAttribute('aria-busy', 'true');
		try {
			const { kind, ...source } = row.source;
			const data = await this.threads.readAttachment({ ...source, contentIndex: kind === 'toolResult' ? row.index : undefined }, row.controller.signal);
			if (row.isDisposed || this.isDisposed) return;
			const expected = row.part.type === 'imageAttachment' ? 'image/' : 'audio/';
			if (!data.mimeType.startsWith(expected)) throw new Error(localize('chat.media.wrongType', 'The attachment has an unexpected media type.'));
			const ownerWindow = this.options.ownerDocument.defaultView;
			if (!ownerWindow) return;
			const objectUrl = createObjectUrl(ownerWindow, new Blob([new Uint8Array(data.bytes)], { type: data.mimeType }));
			row.objectUrl.value = objectUrl.registration;
			if (row.part.type === 'imageAttachment' || row.part.type === 'audioAttachment') {
				const name = `${row.part.type === 'imageAttachment' ? localize('chat.media.image', 'Image') : localize('chat.media.audio', 'Audio')}.${row.part.attachment.mediaType}`;
				row.association.value = this.files.associate(data.bytes, { id: JSON.stringify([row.source, row.index, row.part.type, row.part.attachment.contentDigest]), name });
				row.openButton.hidden = false;
			}
			const focused = this.options.ownerDocument.activeElement === row.loadButton;
			this.reveal(row, objectUrl.url.toString());
			if (focused) row.element.focus();
		} catch (error) {
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

	private async loadResource(row: MediaRow): Promise<void> {
		if (row.part.type !== 'resource' || !this.options.readResource) return;
		row.loading = true;
		row.element.setAttribute('aria-busy', 'true');
		try {
			let blob = await this.options.readResource(row.part.resource, row.controller.signal);
			if ((!blob.type || blob.type === 'application/octet-stream') && row.part.mimeType) blob = new Blob([blob], { type: row.part.mimeType });
			if (row.isDisposed || this.isDisposed) return;
			row.blob = blob;
			row.downloadButton.hidden = false;
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (row.isDisposed || this.isDisposed) return;
			row.association.value = this.files.associate(bytes, { name: row.part.name });
			row.openButton.hidden = false;
			const mime = blob.type.split(';')[0]!.toLowerCase();
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
			} else if (mime === 'application/pdf') {
				row.preview.value = await new PdfJsRenderer().render({ bytes, container: row.media, scale: 1, signal: row.controller.signal });
				if (row.isDisposed || this.isDisposed) { row.preview.clear(); return; }
			} else if (row.part.presentation === 'document') {
				if (/^(?:text\/|application\/(?:json|xml))/u.test(mime)) {
					const text = h(row.element.ownerDocument, 'pre');
					text.textContent = new TextDecoder().decode(bytes);
					row.media.append(text);
				} else { row.media.textContent = localize('chat.resource.binary', 'Binary resource ({0} bytes)', bytes.length); }
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
			if (!row.isDisposed && !this.isDisposed && row.part.type === 'resource' && row.media.matches('img,audio,video') && ['http', 'https'].includes(row.part.resource.scheme) && !row.part.resource.authority.includes('@')) {
				this.reveal(row, row.part.resource.toString());
				row.status.textContent = row.part.name;
				return;
			}
			if (!row.isDisposed && !this.isDisposed) row.setStatus(localize('chat.media.loadFailed', 'Could not load this media: {0}', String(error)));
		} finally {
			if (!row.isDisposed) { row.loading = false; row.element.removeAttribute('aria-busy'); this._onDidChangeHeight.fire(); }
		}
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
		row.loaded = true;
		row.media.setAttribute('src', url);
		row.media.hidden = false;
		row.loadButton.hidden = true;
	}
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

function safeMediaUrl(part: Extract<MediaPart, { readonly type: 'imageUrl' | 'audioUrl'; }>): string | undefined {
	try {
		const url = new URL(part.url);
		if (url.username || url.password) return undefined;
		if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
		const allowed = part.type === 'imageUrl' ? /^data:image\/(png|jpeg|gif|webp);base64,/iu : /^data:audio\/(wav|mpeg|mp4|webm|ogg);base64,/iu;
		return allowed.test(part.url) ? part.url : undefined;
	} catch { return undefined; }
}
