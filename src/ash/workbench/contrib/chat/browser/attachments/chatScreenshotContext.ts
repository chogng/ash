import './chatScreenshotContext.css';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { IRectangle } from '../../../../../platform/window/common/window.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { createImageAttachment } from '../chatImageUtils.js';

/** Reuses the image pipeline so screenshot previews, hashes and draft persistence agree. */
export function convertBufferToScreenshotVariable(buffer: VSBuffer): Promise<ChatContextAttachment> {
	return createImageAttachment(localize('chat.context.screenshotName', 'Screenshot'), buffer.buffer, 'image/png');
}

export function getScreenshotAccessibilityHelp(): string {
	return localize('chat.screenshot.help', 'Screenshot\nThe captured image is frozen until you choose Retake. Choose Entire Window to use the full image, or Select Region to crop it. Drag on the image to select a region, or enter X, Y, Width and Height in image pixels. On the focused image, arrow keys move the region; Shift+arrow keys resize it; Ctrl or Command increases the step to ten pixels. Choose Preview Region to review the crop, then Add to Chat to attach it. Retake captures a fresh image. Escape or Cancel discards the screenshot and returns to the message. Tab and Shift+Tab move between controls. The accessible view reports dimensions and selection coordinates; it does not describe image contents.');
}

interface CapturedImage {
	readonly buffer: VSBuffer;
	readonly bitmap: ImageBitmap;
	readonly url: string;
}

// A window may have several composers. Only the active screenshot workflow owns its modal.
const activeCaptures = new WeakMap<Document, ChatScreenshotContext>();

/** Owns one screenshot attachment acquisition; Host owns capture, the draft owns acceptance. */
export class ChatScreenshotContext extends Disposable {
	private readonly dialog: HTMLDialogElement;
	private readonly image: HTMLImageElement;
	private readonly imageArea: HTMLElement;
	private readonly selection: HTMLElement;
	private readonly dimensions: HTMLElement;
	private readonly fields: HTMLElement;
	private readonly inputs: Record<keyof IRectangle, HTMLInputElement>;
	private readonly confirm: Button;
	private readonly controls: Button[] = [];
	private original: CapturedImage | undefined;
	private preview: { readonly buffer: VSBuffer; readonly url: string; readonly width: number; readonly height: number; } | undefined;
	private region: IRectangle = { x: 0, y: 0, width: 1, height: 1 };
	private selecting = false;
	private busy = false;
	private finished = false;
	private accessibilityOpen = false;
	private resolve: ((buffer: VSBuffer | undefined) => void) | undefined;
	private reject: ((error: unknown) => void) | undefined;
	private drag: { readonly id: number; readonly x: number; readonly y: number; } | undefined;

	constructor(
		container: HTMLElement,
		@IHostService private readonly host: IHostService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
			const node = document.createElement(tag);
			if (className) node.className = className;
			return node;
		};
		this.dialog = element('dialog', 'chat-screenshot-dialog');
		this.dialog.setAttribute('aria-label', localize('chat.screenshot.title', 'Screenshot Preview'));
		const header = element('div', 'chat-screenshot-header');
		const title = element('h2');
		title.textContent = localize('chat.screenshot.title', 'Screenshot Preview');
		header.append(title);
		this.dimensions = element('span', 'chat-screenshot-dimensions');
		this.dimensions.setAttribute('role', 'status');
		header.append(this.dimensions);
		const toolbar = element('div', 'chat-screenshot-toolbar');
		const action = (parent: HTMLElement, label: string, run: () => void, primary = false): Button => {
			const button = this._register(new Button(parent, { label, presentation: primary ? 'primary' : 'secondary' }));
			this._register(button.onDidClick(run));
			this.controls.push(button);
			return button;
		};
		action(toolbar, localize('chat.screenshot.entire', 'Entire Window'), () => this.showEntire());
		action(toolbar, localize('chat.screenshot.select', 'Select Region'), () => this.selectRegion());
		action(toolbar, localize('chat.screenshot.retake', 'Retake'), () => { void this.capture(); });
		const stage = element('div', 'chat-screenshot-stage');
		this.imageArea = element('div', 'chat-screenshot-image-area');
		this.imageArea.tabIndex = 0;
		this.imageArea.setAttribute('role', 'group');
		this.imageArea.setAttribute('aria-label', localize('chat.screenshot.imageArea', 'Screenshot image and region selection'));
		this.image = element('img');
		this.image.alt = localize('chat.screenshot.image', 'Captured screenshot');
		this.image.draggable = false;
		this.selection = element('div', 'chat-screenshot-selection');
		this.selection.setAttribute('aria-hidden', 'true');
		this.imageArea.append(this.image, this.selection);
		stage.append(this.imageArea);
		this.fields = element('div', 'chat-screenshot-fields');
		this.inputs = {} as Record<keyof IRectangle, HTMLInputElement>;
		const labels: Record<keyof IRectangle, string> = {
			x: localize('chat.screenshot.x', 'X'), y: localize('chat.screenshot.y', 'Y'),
			width: localize('chat.screenshot.width', 'Width'), height: localize('chat.screenshot.height', 'Height'),
		};
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			const label = element('label');
			label.append(labels[key]);
			const input = this.inputs[key] = element('input');
			input.type = 'number';
			input.step = '1';
			input.min = key === 'x' || key === 'y' ? '0' : '1';
			label.append(input);
			this.fields.append(label);
			this._register(addDisposableListener(input, 'change', () => {
				if (Number.isFinite(input.valueAsNumber)) this.updateRegion({ ...this.region, [key]: Math.round(input.valueAsNumber) });
				else this.updateRegion(this.region);
			}));
		}
		const hint = element('p', 'chat-screenshot-hint');
		hint.id = `screenshot-hint-${createUuid()}`;
		hint.textContent = localize('chat.screenshot.instructions', 'Select a region by dragging, or use the coordinate fields. Review the image before adding it to chat.');
		this.dialog.setAttribute('aria-describedby', hint.id);
		const footer = element('div', 'chat-screenshot-footer');
		action(footer, localize('chat.screenshot.cancel', 'Cancel'), () => this.finish());
		this.confirm = action(footer, localize('chat.screenshot.attach', 'Add to Chat'), () => {
			if (this.selecting) void this.crop();
			else this.finish(this.preview?.buffer);
		}, true);
		this.dialog.append(header, toolbar, stage, this.fields, hint, footer);
		container.append(this.dialog);
		this._register(addDisposableListener(this.dialog, 'cancel', event => { event.preventDefault(); this.finish(); }));
		this._register(addDisposableListener(document, 'keydown', event => {
			if (event.key === 'Escape' && !this.dialog.open && !this.accessibilityOpen && activeCaptures.get(document) === this) {
				event.preventDefault();
				this.finish();
			}
		}, true));
		this._register(addDisposableListener(this.imageArea, 'pointerdown', event => {
			if (!this.selecting || event.button !== 0 || this.drag) return;
			const point = this.imagePoint(event);
			this.drag = { id: event.pointerId, ...point };
			this.imageArea.setPointerCapture(event.pointerId);
			this.imageArea.focus();
			event.preventDefault();
		}));
		this._register(addDisposableListener(this.imageArea, 'pointermove', event => {
			if (this.drag?.id !== event.pointerId) return;
			const point = this.imagePoint(event);
			this.updateRegion({
				x: Math.min(point.x, this.drag.x), y: Math.min(point.y, this.drag.y),
				width: Math.abs(point.x - this.drag.x), height: Math.abs(point.y - this.drag.y),
			});
		}));
		for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
			this._register(addDisposableListener(this.imageArea, event, () => { this.drag = undefined; }));
		}
		this._register(addDisposableListener(this.imageArea, 'keydown', event => {
			if (!this.selecting || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
			event.preventDefault();
			event.stopPropagation();
			const step = event.ctrlKey || event.metaKey ? 10 : 1;
			const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
			const key = event.shiftKey ? (horizontal ? 'width' : 'height') : (horizontal ? 'x' : 'y');
			const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : step;
			this.updateRegion({ ...this.region, [key]: this.region[key] + delta });
		}));
		this._register(addDisposableListener(document.defaultView!, 'pagehide', () => this.finish()));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `chatScreenshot-${type}-${createUuid()}`,
				getProvider: () => {
					if (!this.dialog.contains(document.activeElement) || this.finished) return undefined;
					const focus = document.activeElement as HTMLElement;
					// Native modal inertness must not prevent the accessible editor from receiving focus.
					this.accessibilityOpen = true;
					this.dialog.close();
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatScreenshot, { type },
						() => type === AccessibleViewType.Help ? getScreenshotAccessibilityHelp() : this.describe(),
						() => {
							this.accessibilityOpen = false;
							if (!this.finished && !this.isDisposed) {
								this.dialog.showModal();
								focus.focus();
							}
						},
						AccessibilityVerbositySettingId.ChatScreenshot);
				},
			}));
		}
		this._register(toDisposable(() => {
			this.finish();
			this.releaseImages();
			this.dialog.remove();
			if (activeCaptures.get(document) === this) activeCaptures.delete(document);
		}));
	}

	public run(signal: AbortSignal): Promise<VSBuffer | undefined> {
		if (signal.aborted || this.isDisposed) return Promise.resolve(undefined);
		const document = this.dialog.ownerDocument;
		activeCaptures.get(document)?.finish();
		activeCaptures.set(document, this);
		this._register(addDisposableListener(signal, 'abort', () => this.finish()));
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
			void this.capture();
		});
	}

	private finish(buffer?: VSBuffer, error?: unknown): void {
		if (this.finished) return;
		this.finished = true;
		this.dialog.close();
		if (error) this.reject?.(error); else this.resolve?.(buffer);
	}

	private async capture(): Promise<void> {
		if (this.busy || this.finished) return;
		this.setBusy(true);
		this.dialog.close();
		try {
			// Let the source picker and any previous preview leave the compositor before capturing.
			await this.afterPaint();
			await this.afterPaint();
			if (this.finished) return;
			const buffer = await this.host.getScreenshot();
			if (this.finished) return;
			if (!buffer) { this.finish(); return; }
			if (buffer.byteLength > 20 * 1024 * 1024) throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(buffer.buffer)], { type: 'image/png' }));
			if (this.finished) { bitmap.close(); return; }
			if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 67_108_864) {
				bitmap.close();
				throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
			}
			this.releaseImages();
			this.original = { buffer, bitmap, url: URL.createObjectURL(new Blob([new Uint8Array(buffer.buffer)], { type: 'image/png' })) };
			this.showEntire();
			this.setBusy(false);
			this.dialog.showModal();
			this.confirm.focus();
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ChatScreenshot);
			if (hint) status(localize('chat.screenshot.helpHint', 'Screenshot preview. {0}', hint));
		} catch (error) {
			this.finish(undefined, new Error(localize('chat.screenshot.failed', 'Could not capture the screenshot: {0}', String(error))));
		} finally {
			if (!this.finished) this.setBusy(false);
		}
	}

	private afterPaint(): Promise<void> {
		return new Promise(resolve => {
			const window = this.dialog.ownerDocument.defaultView!;
			const frame = window.requestAnimationFrame(() => { this._store.delete(resource); resource.dispose(); });
			const resource = toDisposable(() => { window.cancelAnimationFrame(frame); resolve(); });
			this._register(resource);
		});
	}

	private releaseImages(): void {
		if (this.preview && this.preview.url !== this.original?.url) URL.revokeObjectURL(this.preview.url);
		this.preview = undefined;
		if (this.original) { URL.revokeObjectURL(this.original.url); this.original.bitmap.close(); }
		this.original = undefined;
	}

	private showEntire(): void {
		if (!this.original) return;
		if (this.preview && this.preview.url !== this.original.url) URL.revokeObjectURL(this.preview.url);
		this.preview = { buffer: this.original.buffer, url: this.original.url, width: this.original.bitmap.width, height: this.original.bitmap.height };
		this.selecting = false;
		this.render();
	}

	private selectRegion(): void {
		if (!this.original) return;
		this.selecting = true;
		const { width, height } = this.original.bitmap;
		this.updateRegion({
			x: Math.floor(width / 4), y: Math.floor(height / 4),
			width: Math.max(1, Math.floor(width / 2)), height: Math.max(1, Math.floor(height / 2)),
		});
		this.imageArea.focus();
	}

	private updateRegion(rect: IRectangle): void {
		if (!this.original) return;
		const { width, height } = this.original.bitmap;
		const x = Math.max(0, Math.min(width - 1, rect.x));
		const y = Math.max(0, Math.min(height - 1, rect.y));
		this.region = { x, y, width: Math.max(1, Math.min(width - x, rect.width)), height: Math.max(1, Math.min(height - y, rect.height)) };
		this.render();
	}

	private imagePoint(event: PointerEvent): { x: number; y: number; } {
		const bounds = this.image.getBoundingClientRect();
		const { width, height } = this.original!.bitmap;
		return {
			x: Math.max(0, Math.min(width, Math.round((event.clientX - bounds.left) / bounds.width * width))),
			y: Math.max(0, Math.min(height, Math.round((event.clientY - bounds.top) / bounds.height * height))),
		};
	}

	private async crop(): Promise<void> {
		if (this.busy || !this.original || this.finished) return;
		this.setBusy(true);
		try {
			const { x, y, width, height } = this.region;
			const canvas = this.dialog.ownerDocument.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error(localize('chat.image.unavailable', 'Image processing is unavailable'));
			context.drawImage(this.original.bitmap, x, y, width, height, 0, 0, width, height);
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
			if (!blob) throw new Error(localize('chat.image.unavailable', 'Image processing is unavailable'));
			const buffer = VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer()));
			if (this.finished) return;
			if (this.preview && this.preview.url !== this.original.url) URL.revokeObjectURL(this.preview.url);
			this.preview = { buffer, url: URL.createObjectURL(blob), width, height };
			this.selecting = false;
			this.render();
			this.setBusy(false);
			this.confirm.focus();
		} catch (error) { this.finish(undefined, error); }
		finally { if (!this.finished) this.setBusy(false); }
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		for (const control of this.controls) control.enabled = !busy;
		for (const input of Object.values(this.inputs)) input.disabled = busy;
		this.dialog.setAttribute('aria-busy', String(busy));
	}

	private describe(): string {
		if (this.selecting) return localize('chat.screenshot.selectionDescription', 'Selected region: X {0}, Y {1}, Width {2}, Height {3} pixels. Image contents are not described.', this.region.x, this.region.y, this.region.width, this.region.height);
		return localize('chat.screenshot.description', 'Screenshot preview: {0} × {1} pixels. Image contents are not described. Choose Add to Chat to attach this image.', this.preview?.width ?? 0, this.preview?.height ?? 0);
	}

	private render(): void {
		const original = this.original!;
		this.image.src = this.selecting ? original.url : this.preview!.url;
		this.fields.hidden = !this.selecting;
		this.selection.hidden = !this.selecting;
		this.imageArea.classList.toggle('selecting', this.selecting);
		this.confirm.label = this.selecting ? localize('chat.screenshot.previewRegion', 'Preview Region') : localize('chat.screenshot.attach', 'Add to Chat');
		this.dimensions.textContent = this.selecting
			? localize('chat.screenshot.regionSize', '{0} × {1} pixels selected', this.region.width, this.region.height)
			: localize('chat.screenshot.size', '{0} × {1} pixels', this.preview!.width, this.preview!.height);
		const { x, y, width, height } = this.region;
		Object.assign(this.selection.style, {
			left: `${100 * x / original.bitmap.width}%`, top: `${100 * y / original.bitmap.height}%`,
			width: `${100 * width / original.bitmap.width}%`, height: `${100 * height / original.bitmap.height}%`,
		});
		const limits = { x: original.bitmap.width - 1, y: original.bitmap.height - 1, width: original.bitmap.width - x, height: original.bitmap.height - y };
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			this.inputs[key].value = String(this.region[key]);
			this.inputs[key].max = String(limits[key]);
		}
	}
}
