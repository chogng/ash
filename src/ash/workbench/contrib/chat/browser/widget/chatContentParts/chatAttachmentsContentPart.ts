import './media/chatMarkdownPart.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { createObjectUrl } from '../../../../../../base/browser/fileAccess.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IAgentThreadService, type ChatContentPart } from '../../../../../../platform/agentHost/common/agentService.js';
import type { IChatListItem } from '../chatListItems.js';

export interface IChatAttachmentsContentPartOptions {
	readonly ownerDocument: Document;
	readonly variables: readonly ChatContentPart[];
	readonly source?: IChatListItem['attachmentSource'];
}

type MediaPart = Exclude<ChatContentPart, { readonly type: 'text'; }>;

/** One media row owns its request, playback and decoded URL for exactly this transcript entry. */
class MediaRow extends Disposable {
	public readonly element: HTMLElement;
	public readonly status: HTMLElement;
	public readonly loadButton: HTMLButtonElement;
	public readonly media: HTMLImageElement | HTMLAudioElement;
	public readonly objectUrl = this._register(new MutableDisposable());
	public readonly resources = this._register(new DisposableStore());
	public readonly controller = new AbortController();
	public loaded = false;
	public loading = false;

	constructor(document: Document, public readonly part: MediaPart, public readonly source: IChatListItem['attachmentSource'], public readonly index: number) {
		super();
		this.element = h(document, 'figure');
		this.element.className = 'ash-chat-media';
		this.element.tabIndex = -1;
		this.status = h(document, 'figcaption');
		const image = part.type === 'imageAttachment' || part.type === 'imageUrl';
		const label = image ? localize('chat.media.image', 'Image') : localize('chat.media.audio', 'Audio');
		this.status.textContent = part.type === 'imageAttachment'
			? localize('chat.media.imageDimensions', 'Image ({0} × {1})', part.attachment.width, part.attachment.height)
			: part.type === 'audioAttachment'
				? localize('chat.media.audioDuration', 'Audio ({0} seconds)', Math.ceil(part.attachment.durationMs / 1000)) : label;
		this.media = h(document, image ? 'img' : 'audio');
		this.media.setAttribute('aria-label', this.status.textContent);
		if (image) {
			const preview = this.media as HTMLImageElement;
			preview.alt = this.status.textContent;
			preview.loading = 'lazy';
		} else {
			const player = this.media as HTMLAudioElement;
			player.controls = true;
			player.preload = 'none';
		}
		this.media.hidden = true;
		this.loadButton = h(document, 'button');
		this.loadButton.type = 'button';
		this.loadButton.textContent = image ? localize('chat.media.loadImage', 'Load image') : localize('chat.media.loadAudio', 'Load audio');
		this.element.append(this.status, this.loadButton, this.media);
		this._register(toDisposable(() => {
			this.controller.abort();
			if (!image && this.loaded) {
				(this.media as HTMLAudioElement).pause();
				this.media.removeAttribute('src');
				(this.media as HTMLAudioElement).load();
			} else this.media.removeAttribute('src');
			this.element.remove();
		}));
	}
}

/** Presents user and tool media from the same Agent Thread contract, without retaining backend handles. */
export class ChatAttachmentsContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly rows = this._register(new DisposableMap<number, MediaRow>());
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(private readonly options: IChatAttachmentsContentPartOptions, @IAgentThreadService private readonly threads: IAgentThreadService) {
		super();
		this.domNode = h(options.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-media-attachments';
		this._register(toDisposable(() => this.domNode.remove()));
		this.updateVariables(options.variables, options.source);
	}

	public updateVariables(variables: readonly ChatContentPart[], source = this.options.source): void {
		const indices = new Set(variables.flatMap((part, index) => part.type === 'text' ? [] : [index]));
		for (const [index] of this.rows) if (!indices.has(index)) this.rows.deleteAndDispose(index);
		for (const [index, part] of variables.entries()) {
			if (part.type === 'text') continue;
			let row = this.rows.get(index);
			if (!row || !sameMedia(row.part, part) || !sameSource(row.source, source)) {
				row = this.rows.set(index, new MediaRow(this.options.ownerDocument, part, source, index));
				const current = row;
				// The row owns listeners even when a later update replaces it at the same content index.
				row.resources.add(addDisposableListener(row.loadButton, 'click', () => { void this.load(current); }));
				row.resources.add(addDisposableListener(row.media, 'load', () => this._onDidChangeHeight.fire()));
				row.resources.add(addDisposableListener(row.media, 'loadedmetadata', () => this._onDidChangeHeight.fire()));
				row.resources.add(addDisposableListener(row.media, 'error', () => {
					current.status.textContent = localize('chat.media.unavailable', 'This media could not be loaded.');
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
			}
			this.domNode.append(row.element);
		}
		this._onDidChangeHeight.fire();
	}

	private async load(row: MediaRow): Promise<void> {
		if (row.loaded || row.loading || row.isDisposed) return;
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
			const focused = this.options.ownerDocument.activeElement === row.loadButton;
			this.reveal(row, objectUrl.url.toString());
			if (focused) row.element.focus();
		} catch (error) {
			if (!row.isDisposed && !this.isDisposed) row.status.textContent = localize('chat.media.loadFailed', 'Could not load this media: {0}', String(error));
		} finally {
			if (!row.isDisposed) {
				row.loading = false;
				row.loadButton.removeAttribute('aria-disabled');
				row.element.removeAttribute('aria-busy');
				this._onDidChangeHeight.fire();
			}
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
	if ('url' in left) return 'url' in right && left.url === right.url;
	return 'attachment' in right && left.attachment.contentDigest === right.attachment.contentDigest;
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
