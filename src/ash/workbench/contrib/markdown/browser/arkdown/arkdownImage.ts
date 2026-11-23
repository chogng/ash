import './media/arkdownImage.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../../base/browser/observer.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { ArkdownImageLayout } from './arkdownImages.js';

interface ImageHost {
	canEdit(): boolean;
	select(): void;
	leave(): void;
	change(layout: ArkdownImageLayout, description?: string): void;
	remove(): void;
	onError(error: unknown): void;
	changed(): void;
}

/** Transient selection and drag geometry; the host commits every edit to Markdown. */
export class ArkdownImage extends Disposable {
	readonly domNode: HTMLElement;
	private readonly image: HTMLImageElement;
	private readonly handles: HTMLElement[] = [];
	private readonly drag = this._register(new DisposableStore());
	private cancelDrag: (() => void) | undefined;
	private menuVisible = false;

	constructor(parent: HTMLElement, source: string, private readonly description: string, private readonly layout: ArkdownImageLayout, private readonly host: ImageHost,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super();
		const document = parent.ownerDocument;
		this.domNode = h(document, 'span', { className: 'ash-arkdown-image', attributes: { contenteditable: 'false', tabindex: '0', role: 'group', 'aria-label': localize({ bundle: 'ash.docs', key: 'documentImage' }, 'Image: {0}', description || localize({ bundle: 'ash.docs', key: 'image' }, 'Image')) } });
		if (layout.width !== undefined) this.domNode.style.width = `${layout.width}px`;
		this.domNode.dataset.align = layout.alignment;
		this.image = h(document, 'img', { attributes: { src: source, alt: description, loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' } });
		this.domNode.append(this.image);
		parent.append(this.domNode);
		this._register(addDisposableListener(this.image, 'load', () => { this.update(); this.host.changed(); }));
		this._register(addDisposableListener(this.image, 'error', () => {
			this.domNode.classList.add('failed');
			this.domNode.setAttribute('aria-label', localize({ bundle: 'ash.docs', key: 'imageLoadFailed' }, 'Image could not load: {0}', description));
			this.host.changed();
		}));
		this._register(addDisposableListener(this.domNode, 'click', event => { event.stopPropagation(); this.focus(); }));
		this._register(addDisposableListener(this.domNode, 'focusin', event => { this.domNode.classList.add('selected'); if (event.target === this.domNode) this.host.select(); }));
		this._register(addDisposableListener(document, 'pointerdown', event => {
			const target = event.target as Element;
			if (!this.menuVisible && !this.domNode.contains(target) && !target.closest('[data-arkdown-selection-controls], .ash-context-view')) this.domNode.classList.remove('selected');
		}, true));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => { event.preventDefault(); event.stopPropagation(); this.focus(); this.showMenu(event.clientX, event.clientY); }));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape' || event.target === this.domNode && (event.key === 'Enter' || event.key === 'ArrowRight')) { event.preventDefault(); event.stopPropagation(); this.cancelDrag?.(); this.domNode.classList.remove('selected'); this.host.leave(); }
			else if ((event.key === 'Backspace' || event.key === 'Delete') && this.host.canEdit()) { event.preventDefault(); event.stopPropagation(); this.host.remove(); }
			else if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); const rect = this.domNode.getBoundingClientRect(); this.showMenu(rect.left, rect.bottom); }
		}));
		for (const side of ['left', 'right'] as const) {
			const handle = h(document, 'span', { className: `ash-arkdown-image-handle ${side}`, attributes: { tabindex: '0', role: 'slider', 'aria-label': localize({ bundle: 'ash.docs', key: 'resizeImage' }, 'Resize image'), 'aria-valuemin': '40', 'aria-valuenow': String(layout.width ?? 40), 'aria-orientation': 'horizontal' } });
			this.handles.push(handle); this.domNode.append(handle);
			this._register(addDisposableListener(handle, 'pointerdown', event => this.startResize(event, side)));
			this._register(addDisposableListener(handle, 'keydown', event => {
				if (!this.host.canEdit()) return;
				const current = this.image.getBoundingClientRect().width, maximum = this.maximumWidth();
				const delta = (event.shiftKey ? 50 : 10) * (event.key === 'ArrowLeft' ? -1 : 1);
				const next = event.key === 'Home' ? 40 : event.key === 'End' ? maximum : ['ArrowLeft', 'ArrowRight'].includes(event.key) ? Math.max(40, Math.min(maximum, current + delta)) : undefined;
				if (next === undefined) return;
				event.preventDefault(); event.stopPropagation(); this.host.change({ ...this.layout, width: Math.round(next) });
			}));
		}
		this._register(observeElementSize(this.domNode, () => this.update()));
		this.update();
	}

	focus(): void { this.domNode.focus(); }
	update(): void {
		const editable = this.host.canEdit();
		if (!editable) this.cancelDrag?.();
		for (const handle of this.handles) { handle.hidden = !editable; handle.setAttribute('aria-disabled', String(!editable)); handle.setAttribute('aria-valuenow', String(Math.round(this.image.getBoundingClientRect().width))); handle.setAttribute('aria-valuemax', String(Math.round(this.maximumWidth()))); }
	}

	private maximumWidth(): number {
		const parent = this.domNode.parentElement!, style = parent.ownerDocument.defaultView!.getComputedStyle(parent);
		return Math.max(40, Math.min(16384, parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
	}
	private startResize(event: PointerEvent, side: 'left' | 'right'): void {
		if (event.button !== 0 || !this.host.canEdit()) return;
		event.preventDefault(); event.stopPropagation();
		this.focus(); this.cancelDrag?.();
		const grip = event.currentTarget as HTMLElement;
		grip.setPointerCapture(event.pointerId);
		const start = event.clientX, width = this.image.getBoundingClientRect().width;
		const maximum = Math.max(width, this.maximumWidth());
		const previous = this.domNode.style.width;
		let next = width;
		const finish = (commit: boolean): void => {
			this.cancelDrag = undefined; this.drag.clear(); this.domNode.classList.remove('resizing');
			if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
			this.domNode.style.width = previous;
			if (commit && this.host.canEdit() && Math.round(next) !== Math.round(width)) { this.host.change({ ...this.layout, width: Math.round(next) }); status(localize({ bundle: 'ash.docs', key: 'imageResized' }, 'Image width: {0} pixels.', Math.round(next))); }
		};
		this.cancelDrag = () => finish(false);
		this.domNode.classList.add('resizing');
		const document = this.domNode.ownerDocument;
		this.drag.add(addDisposableListener(document, 'pointermove', move => {
			if (move.pointerId !== event.pointerId) return;
			next = Math.max(40, Math.min(maximum, width + (move.clientX - start) * (side === 'left' ? -1 : 1)));
			this.domNode.style.width = `${next}px`;
			for (const handle of this.handles) handle.setAttribute('aria-valuenow', String(Math.round(next)));
		}));
		this.drag.add(addDisposableListener(document, 'pointerup', up => { if (up.pointerId === event.pointerId) finish(true); }));
		this.drag.add(addDisposableListener(document, 'pointercancel', () => finish(false)));
		this.drag.add(addDisposableListener(document, 'keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } }, true));
		this.drag.add(addDisposableListener(document.defaultView!, 'blur', () => finish(false)));
	}

	private showMenu(x: number, y: number): void {
		this.menuVisible = true;
		this.menus.showContextMenu({ getAnchor: () => ({ x, y }), getActions: () => this.getActions(this.domNode.closest('.wide') !== null).more, onHide: () => { this.menuVisible = false; if (!this.isDisposed) this.focus(); } });
	}

	getActions(wide: boolean): { readonly alignment: readonly IAction[]; readonly more: readonly IAction[]; } {
		const editable = this.host.canEdit();
		const loaded = this.image.complete && this.image.naturalWidth > 0;
		const action = (id: string, label: string, icon: Icon | undefined, run: () => unknown, enabled = editable, checked?: boolean): IAction => ({ id: `arkdown.image.${id}`, label, tooltip: label, icon, run: () => this.isDisposed || !enabled ? undefined : run(), enabled, checked });
		const sizeNames = [localize({ bundle: 'ash.docs', key: 'smallImage' }, 'Small'), localize({ bundle: 'ash.docs', key: 'mediumImage' }, 'Medium'), localize({ bundle: 'ash.docs', key: 'largeImage' }, 'Large'), localize({ bundle: 'ash.docs', key: 'extraLargeImage' }, 'Extra large')];
		return {
			alignment: (['left', 'center', 'right'] as const).map((alignment, index) => action(`align.${alignment}`, [localize({ bundle: 'ash.docs', key: 'alignImageLeft' }, 'Align image left'), localize({ bundle: 'ash.docs', key: 'alignImageCenter' }, 'Center image'), localize({ bundle: 'ash.docs', key: 'alignImageRight' }, 'Align image right')][index], [Lxicon.alignLeft, Lxicon.alignCenter, Lxicon.alignRight][index], () => this.host.change({ ...this.layout, alignment }), editable, this.layout.alignment === alignment)), more: [
				action('copy', localize({ bundle: 'ash.docs', key: 'copyImage' }, 'Copy image'), Lxicon.copy, () => this.copy().catch(error => this.host.onError(error)), loaded),
				action('description', localize({ bundle: 'ash.docs', key: 'editImageDescription' }, 'Edit image description'), Lxicon.text, async () => {
					try {
						const result = await this.dialogs.input({ title: localize({ bundle: 'ash.docs', key: 'imageDescription' }, 'Image description'), message: localize({ bundle: 'ash.docs', key: 'describeImage' }, 'Describe the image for readers who cannot see it.'), inputs: [{ value: this.description }] });
						if (result.confirmed && !this.isDisposed && this.host.canEdit()) this.host.change(this.layout, result.values?.[0] ?? '');
					} catch (error) { this.host.onError(error); }
				}),
				new SubmenuAction('arkdown.image.size', localize({ bundle: 'ash.docs', key: 'setImageSize' }, 'Set image size'), (wide ? [300, 450, 675, 900] : [224, 336, 504, 672]).map((width, index) => action(`size.${index}`, sizeNames[index], undefined, () => this.host.change({ ...this.layout, width }), editable && loaded, this.layout.width === width))),
				action('reset', localize({ bundle: 'ash.docs', key: 'resetImageSize' }, 'Reset image size'), Lxicon.discard, () => this.host.change({ ...this.layout, width: undefined }), editable && this.layout.width !== undefined),
				new Separator(),
				action('delete', localize({ bundle: 'ash.docs', key: 'deleteImage' }, 'Delete image'), Lxicon.trash, () => this.host.remove()),
			]
		};
	}

	async copy(): Promise<void> {
		try {
			await this.clipboard.writeImage(new Promise<Uint8Array>((resolve, reject) => {
				const canvas = this.domNode.ownerDocument.createElement('canvas');
				canvas.width = this.image.naturalWidth; canvas.height = this.image.naturalHeight;
				try {
					const context = canvas.getContext('2d'); if (!context) throw new Error();
					context.drawImage(this.image, 0, 0);
					canvas.toBlob(blob => { if (blob) void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject); else reject(new Error()); }, 'image/png');
				} catch (error) { reject(error); }
			}));
		} catch (error) { throw new Error(localize({ bundle: 'ash.docs', key: 'imageCopyFailed' }, 'The image could not be copied.'), { cause: error }); }
	}

	async cut(): Promise<void> {
		if (!this.host.canEdit()) return;
		await this.copy();
		if (!this.isDisposed && this.host.canEdit()) this.host.remove();
	}

	override dispose(): void { this.cancelDrag?.(); super.dispose(); }
}
