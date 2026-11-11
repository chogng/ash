import './media/chatImageGallery.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Action } from '../../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatMarkdownRichPart } from '../../../common/model/chatMarkdownRichContent.js';
import { ImageAttachmentWidget } from '../../attachments/chatAttachmentWidgets.js';

interface Slide {
	readonly tile: HTMLElement;
	readonly source?: HTMLAnchorElement;
}

/** Presents one response image at a time and owns the thumbnails and their previews. */
export class ChatImageGallery extends Disposable {
	private readonly thumbnails: ImageAttachmentWidget[] = [];

	constructor(
		gallery: HTMLElement,
		images: Extract<ChatMarkdownRichPart, { kind: 'imageGallery'; }>['images'],
		readImage: (uri: URI, signal: AbortSignal) => Promise<Blob>,
		changedHeight: () => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super();
		const document = gallery.ownerDocument;
		const controller = new AbortController();
		this._register(toDisposable(() => controller.abort()));
		const labels = images.map(image => image.label);
		const resources = new Map<number, Promise<Blob>>();
		// The thumbnails and expanded viewer read the same bytes, including
		// requests still in flight. A failed request can be retried from either.
		const read = (index: number): Promise<Blob> => {
			let request = resources.get(index);
			if (!request) {
				request = readImage(URI.parse(images[index]!.uri), controller.signal).then(blob => {
					if (!blob.type.startsWith('image/')) throw new TypeError('Expected image data');
					return blob;
				}).catch((error: unknown) => { resources.delete(index); throw error; });
				resources.set(index, request);
			}
			return request;
		};
		let onPreviewClose: ((index: number, restoreFocus: boolean) => void) | undefined;
		const stage = h(document, 'div', { className: 'ash-chat-image-gallery-stage' });
		const sources = h(document, 'div', { className: 'ash-chat-image-gallery-sources' });
		gallery.append(stage, sources);
		this._register(toDisposable(() => { stage.remove(); sources.remove(); }));
		const slides = images.map((image, index): Slide => {
			const tile = h(document, 'div', { className: 'ash-chat-image-gallery-tile' });
			tile.hidden = index > 0;
			stage.append(tile);
			const thumbnail = this._register(instantiation.createInstance(ImageAttachmentWidget, {
				id: String(index), name: image.label,
				resolve: async () => ({ content: await read(index) }),
			}, {
				imagePresentation: 'thumbnail', retryOnFailure: true, supportsDeletion: false, shouldFocusClearButton: false,
				imagePreviewGallery: labels.length > 1 ? { index, labels, readImage: read, onClose: (next: number, restoreFocus: boolean) => onPreviewClose?.(next, restoreFocus) } : undefined,
			}, tile));
			this.thumbnails.push(thumbnail);
			this._register(thumbnail.onDidResolvePreview(changedHeight));
			const url = image.source && URI.parse(image.source);
			if (!url || (url.scheme !== 'https' && url.scheme !== 'http')) return { tile };
			const source = h(document, 'a', {
				attributes: {
					href: image.source, rel: 'noopener noreferrer',
					'aria-label': localize('chat.imageGallery.source', 'Source for {0}', image.label),
				},
			}, url.authority);
			source.hidden = tile.hidden;
			sources.append(source);
			return { tile, source };
		});
		if (slides.length <= 1) return;

		gallery.tabIndex = -1;
		const position = h(document, 'div', { className: 'ash-chat-image-gallery-position', attributes: { role: 'status' } });
		const controls = h(document, 'div', { className: 'ash-chat-image-gallery-controls' });
		stage.append(controls, position);
		let selected = 0;
		const updatePosition = () => { position.textContent = localize('chat.imageGallery.position', '{0} / {1}', selected + 1, slides.length); };
		const select = (index: number) => {
			if (selected === index) return;
			const previous = slides[selected];
			if (previous.tile.contains(document.activeElement) || previous.source === document.activeElement) gallery.focus({ preventScroll: true });
			previous.tile.hidden = true;
			if (previous.source) previous.source.hidden = true;
			selected = index;
			const next = slides[selected];
			next.tile.hidden = false;
			if (next.source) next.source.hidden = false;
			updatePosition();
			changedHeight();
		};
		const move = (step: number) => select((selected + step + slides.length) % slides.length);
		onPreviewClose = (index, restoreFocus) => {
			if (this.isDisposed || !gallery.isConnected || selected === index) return;
			select(index);
			if (restoreFocus) this.thumbnails[index]?.focusPreview();
		};
		const previous = this._register(new Action('chat.imageGallery.previous', localize('chat.imageGallery.previous', 'Previous image'), undefined, true, () => move(-1)));
		const next = this._register(new Action('chat.imageGallery.next', localize('chat.imageGallery.next', 'Next image'), undefined, true, () => move(1)));
		previous.icon = Lxicon.chevronLeft;
		next.icon = Lxicon.chevronRight;
		previous.tooltip = previous.label;
		next.tooltip = next.label;
		const toolbar = this._register(new WorkbenchToolBar(controls, menus, {
			ariaLabel: localize('chat.imageGallery.navigation', 'Image navigation'), tabNavigation: 'each-action',
		}));
		toolbar.setActions([previous, next]);
		updatePosition();
		this._register(addDisposableListener(gallery, 'keydown', event => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
			event.preventDefault();
			event.stopPropagation();
			move(event.key === 'ArrowLeft' ? -1 : 1);
		}, true));
	}

	closePreviews(): void {
		for (const thumbnail of this.thumbnails) thumbnail.closePreview();
	}
}
