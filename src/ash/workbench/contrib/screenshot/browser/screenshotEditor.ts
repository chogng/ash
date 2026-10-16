import { getScreenshotAccessibilityHelp } from '../common/screenshot.js';
import './screenshotEditor.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IRectangle } from '../../../../platform/window/common/window.js';
import type { ScreenshotCompletion } from '../common/screenshotProtocol.js';
import { SCREENSHOT_MAX_PIXELS } from '../../../../platform/native/common/native.js';
import {
	clampScreenshotRectangle,
	paintScreenshotAnnotation,
	screenshotRectangle,
	type ScreenshotAnnotation,
	type ScreenshotPoint,
	type ScreenshotTool
} from './screenshotEditorModel.js';


interface ScreenshotEditorOptions {
	readonly accessibilityHints: boolean;
	/** False keeps the editor open, for example after cancelling the save dialog. */
	readonly complete: (result: ScreenshotCompletion) => Promise<boolean>;
}

type Drag = {
	readonly id: number;
	readonly start: ScreenshotPoint;
	readonly rect: IRectangle | undefined;
	readonly handle: string;
	points: ScreenshotPoint[];
};

/** One frozen image, one selection and one ordered annotation history own both preview and export. */
export class ScreenshotEditor extends Disposable {
	readonly element: HTMLDialogElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly imageArea: HTMLElement;
	private readonly selection: HTMLElement;
	private readonly dimensions: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly fields: HTMLElement;
	private readonly inputs = new Map<keyof IRectangle, HTMLInputElement>();
	private readonly toolButtons = new Map<ScreenshotTool, HTMLButtonElement>();
	private readonly helpListeners = this._register(new DisposableStore());
	private readonly shades: HTMLElement[] = [];
	private readonly status: HTMLElement;
	private readonly help: HTMLDialogElement;
	private readonly textInput: HTMLInputElement;
	private readonly color: HTMLInputElement;
	private readonly lineWidth: HTMLSelectElement;
	private readonly controls: HTMLButtonElement[] = [];
	private readonly bitmap: ImageBitmap;
	private readonly originalFocus: HTMLElement | null;
	private readonly document: Document;
	private readonly context: CanvasRenderingContext2D;
	private region: IRectangle | undefined;
	private annotations: ScreenshotAnnotation[] = [];
	private tool: ScreenshotTool = 'select';
	private drag: Drag | undefined;
	private textPoint: ScreenshotPoint | undefined;
	private busy = false;
	private pendingAnnotation: ScreenshotAnnotation | undefined;

	private constructor(
		document: Document,
		bitmap: ImageBitmap,
		private readonly options: ScreenshotEditorOptions
	) {
		super();
		this.document = document;
		this.bitmap = bitmap;
		this.originalFocus = document.activeElement as HTMLElement | null;
		const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
			const element = document.createElement(tag);
			if (className) element.className = className;
			return element;
		};
		this.element = node('dialog', 'ash-screenshot-overlay');
		this.element.setAttribute('aria-label', localize('screenshot.title', 'Screen Capture'));
		this.imageArea = node('div', 'ash-screenshot-surface');
		this.imageArea.tabIndex = 0;
		this.imageArea.setAttribute('role', 'group');
		this.imageArea.setAttribute('aria-label', localize('screenshot.surface', 'Frozen screen and region selection'));
		this.canvas = node('canvas', 'ash-screenshot-image');
		this.canvas.width = bitmap.width;
		this.canvas.height = bitmap.height;
		this.canvas.setAttribute('aria-hidden', 'true');
		this.context = this.canvas.getContext('2d', { willReadFrequently: true })!;
		this.selection = node('div', 'ash-screenshot-selection');
		this.selection.hidden = true;
		for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
			const grip = node('span', `ash-screenshot-handle ash-screenshot-handle-${handle}`);
			grip.dataset.handle = handle;
			this.selection.append(grip);
		}
		this.imageArea.append(this.canvas);
		for (let index = 0; index < 4; index++) {
			const shade = node('div', 'ash-screenshot-shade');
			shade.setAttribute('aria-hidden', 'true');
			this.shades.push(shade);
			this.imageArea.append(shade);
		}
		this.imageArea.append(this.selection);
		this.dimensions = node('div', 'ash-screenshot-dimensions');
		this.dimensions.hidden = true;
		this.toolbar = node('div', 'ash-screenshot-toolbar');
		this.toolbar.setAttribute('role', 'group');
		this.toolbar.setAttribute('aria-label', localize('screenshot.tools', 'Screenshot tools'));
		this.toolbar.hidden = true;
		const button = (parent: HTMLElement, label: string, run: () => void, primary = false): HTMLButtonElement => {
			const element = node('button');
			element.type = 'button';
			element.textContent = label;
			element.title = label;
			if (primary) element.classList.add('primary');
			this._register(addDisposableListener(element, 'click', run));
			this.controls.push(element);
			parent.append(element);
			return element;
		};
		const tools = node('div', 'ash-screenshot-tool-row');
		const toolNames: Record<ScreenshotTool, string> = {
			select: localize('screenshot.select', 'Select'),
			rectangle: localize('screenshot.rectangle', 'Rectangle'),
			arrow: localize('screenshot.arrow', 'Arrow'),
			pen: localize('screenshot.pen', 'Pen'),
			text: localize('screenshot.text', 'Text'),
			mosaic: localize('screenshot.mosaic', 'Mosaic')
		};
		for (const tool of Object.keys(toolNames) as ScreenshotTool[]) {
			this.toolButtons.set(
				tool,
				button(tools, toolNames[tool], () => this.selectTool(tool))
			);
		}
		this.color = node('input');
		this.color.type = 'color';
		// Annotation ink is image content, independent of the surrounding workbench theme.
		this.color.value = '#ef4444';
		this.color.setAttribute('aria-label', localize('screenshot.color', 'Annotation color'));
		this.color.title = localize('screenshot.color', 'Annotation color');
		this.lineWidth = node('select');
		this.lineWidth.setAttribute('aria-label', localize('screenshot.lineWidth', 'Line width'));
		for (const width of [2, 4, 8]) {
			const option = node('option');
			option.value = String(width);
			option.textContent = localize('screenshot.linePixels', '{0} px', width);
			this.lineWidth.append(option);
		}
		this.lineWidth.value = '4';
		tools.append(this.color, this.lineWidth);
		button(tools, localize('screenshot.undo', 'Undo'), () => {
			this.annotations.pop();
			this.paint();
			this.announce();
		});
		const actions = node('div', 'ash-screenshot-tool-row');
		button(actions, localize('screenshot.coordinates', 'Coordinates'), () => {
			this.fields.hidden = !this.fields.hidden;
			this.positionToolbar();
			if (!this.fields.hidden) this.inputs.get('x')!.focus();
		});
		button(actions, localize('screenshot.helpTitle', 'Screenshot Help'), () => this.showAccessibleContent(false));
		button(actions, localize('screenshot.retake', 'Retake'), () => {
			void this.complete({ kind: 'retake' });
		});
		button(actions, localize('screenshot.cancel', 'Cancel'), () => {
			void this.complete({ kind: 'cancel' });
		});
		button(actions, localize('screenshot.save', 'Save'), () => {
			void this.export('save');
		}).title = localize('screenshot.saveTitle', 'Save screenshot');
		button(actions, localize('screenshot.copy', 'Copy'), () => {
			void this.export('copy');
		});
		button(
			actions,
			localize('chat.screenshot.attach', 'Add to Chat'),
			() => {
				void this.export('attach');
			},
			true
		);
		this.fields = node('div', 'ash-screenshot-fields');
		this.fields.hidden = true;
		const labels: Record<keyof IRectangle, string> = {
			x: localize('chat.screenshot.x', 'X'),
			y: localize('chat.screenshot.y', 'Y'),
			width: localize('chat.screenshot.width', 'Width'),
			height: localize('chat.screenshot.height', 'Height')
		};
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			const label = node('label');
			label.textContent = labels[key];
			const input = node('input');
			input.type = 'number';
			input.step = '1';
			label.append(input);
			this.inputs.set(key, input);
			this.fields.append(label);
			this._register(
				addDisposableListener(input, 'change', () => {
					if (!this.region) return;
					if (Number.isFinite(input.valueAsNumber))
						this.setRegion({ ...this.region, [key]: input.valueAsNumber });
					this.render();
					this.announce();
				})
			);
		}
		this.toolbar.append(tools, actions, this.fields);
		const hint = node('div', 'ash-screenshot-instructions');
		hint.textContent = localize('screenshot.instructions', 'Drag to capture a region · Esc to cancel');
		button(hint, localize('screenshot.entire', 'Entire screen'), () => this.selectEntire());
		button(hint, localize('screenshot.helpTitle', 'Screenshot Help'), () => this.showAccessibleContent(false));
		button(hint, localize('screenshot.cancel', 'Cancel'), () => {
			void this.complete({ kind: 'cancel' });
		});
		this.textInput = node('input', 'ash-screenshot-text');
		this.textInput.type = 'text';
		this.textInput.maxLength = 2000;
		this.textInput.setAttribute('aria-label', localize('screenshot.textInput', 'Annotation text'));
		this.textInput.placeholder = localize('screenshot.textPlaceholder', 'Type text and press Enter');
		this.textInput.hidden = true;
		this.status = node('div', 'ash-screenshot-status');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.help = node('dialog', 'ash-screenshot-help');
		this.element.append(
			this.imageArea,
			hint,
			this.dimensions,
			this.toolbar,
			this.textInput,
			this.status,
			this.help
		);
		document.body.append(this.element);
		this._register(
			toDisposable(() => {
				this.bitmap.close();
				this.element.remove();
				if (this.originalFocus?.isConnected) this.originalFocus.focus();
			})
		);
		this._register(
			addDisposableListener(this.element, 'cancel', (event) => {
				event.preventDefault();
				void this.complete({ kind: 'cancel' });
			})
		);
		this._register(addDisposableListener(this.imageArea, 'pointerdown', (event) => this.pointerDown(event)));
		this._register(addDisposableListener(this.imageArea, 'pointermove', (event) => this.pointerMove(event)));
		this._register(addDisposableListener(this.imageArea, 'pointerup', (event) => this.pointerUp(event)));
		for (const event of ['pointercancel', 'lostpointercapture'] as const) {
			this._register(
				addDisposableListener(this.imageArea, event, () => {
					this.drag = undefined;
					this.pendingAnnotation = undefined;
					this.element.classList.remove('dragging');
					this.paint();
				})
			);
		}
		this._register(addDisposableListener(document, 'keydown', (event) => this.keyDown(event), true));
		this._register(
			addDisposableListener(this.textInput, 'keydown', (event) => {
				if (event.key === 'Enter' && !event.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					this.commitText();
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					this.textInput.hidden = true;
					this.textPoint = undefined;
					this.imageArea.focus();
				}
			})
		);
		this._register(addDisposableListener(document.defaultView!, 'resize', () => this.render()));
		this.selectTool('select');
		this.paint();
		this.element.showModal();
		this.imageArea.focus();
		this.render();
		if (options.accessibilityHints)
			this.status.textContent = localize(
				'screenshot.hint',
				'Screen capture. Drag to select a region, or choose Entire screen. Press Alt+F1 for help.'
			);
	}

	static async create(
		document: Document,
		image: Uint8Array,
		options: ScreenshotEditorOptions
	): Promise<ScreenshotEditor> {
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: 'image/png' }));
		if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > SCREENSHOT_MAX_PIXELS) {
			bitmap.close();
			throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
		}
		try {
			return new ScreenshotEditor(document, bitmap, options);
		} catch (error) {
			bitmap.close();
			throw error;
		}
	}

	private selectTool(tool: ScreenshotTool): void {
		this.commitText();
		this.tool = tool;
		this.element.dataset.tool = tool;
		for (const [candidate, button] of this.toolButtons)
			button.setAttribute('aria-pressed', String(candidate === tool));
		this.imageArea.focus();
	}

	private point(event: PointerEvent): ScreenshotPoint {
		const bounds = this.canvas.getBoundingClientRect();
		return {
			x: Math.max(
				0,
				Math.min(
					this.bitmap.width,
					Math.round(((event.clientX - bounds.left) * this.bitmap.width) / bounds.width)
				)
			),
			y: Math.max(
				0,
				Math.min(
					this.bitmap.height,
					Math.round(((event.clientY - bounds.top) * this.bitmap.height) / bounds.height)
				)
			)
		};
	}

	private pointerDown(event: PointerEvent): void {
		if (event.button !== 0 || this.busy || this.drag) return;
		event.preventDefault();
		this.commitText();
		const start = this.point(event);
		const inside =
			this.region &&
			start.x >= this.region.x &&
			start.y >= this.region.y &&
			start.x <= this.region.x + this.region.width &&
			start.y <= this.region.y + this.region.height;
		if (this.tool === 'text' && inside) {
			this.textPoint = start;
			const bounds = this.canvas.getBoundingClientRect();
			Object.assign(this.textInput.style, {
				left: `${event.clientX}px`,
				top: `${event.clientY}px`,
				maxWidth: `${Math.max(100, bounds.right - event.clientX)}px`,
				color: this.color.value
			});
			this.textInput.value = '';
			this.textInput.hidden = false;
			this.textInput.focus();
			return;
		}
		const handle =
			(event.target as HTMLElement).dataset.handle ?? (inside && this.tool === 'select' ? 'move' : 'new');
		this.drag = { id: event.pointerId, start, rect: this.region, handle, points: [start] };
		if (this.tool === 'select' || !inside) {
			if (handle === 'new') {
				this.annotations = [];
				this.tool = 'select';
				this.selectTool('select');
				this.setRegion(screenshotRectangle(start, start));
			}
		} else this.pendingAnnotation = this.annotation([start, start]);
		this.element.classList.add('dragging');
		this.imageArea.setPointerCapture(event.pointerId);
		this.imageArea.focus();
	}

	private pointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.id !== event.pointerId) return;
		const point = this.point(event);
		if (this.pendingAnnotation) {
			const rect = this.region!;
			const clipped = {
				x: Math.max(rect.x, Math.min(rect.x + rect.width, point.x)),
				y: Math.max(rect.y, Math.min(rect.y + rect.height, point.y))
			};
			drag.points = this.tool === 'pen' ? [...drag.points, clipped] : [drag.start, clipped];
			this.pendingAnnotation = this.annotation(drag.points);
			this.paint();
			return;
		}
		if (drag.handle === 'new' || !drag.rect) this.setRegion(screenshotRectangle(drag.start, point));
		else if (drag.handle === 'move') {
			this.setRegion({
				...drag.rect,
				x: Math.max(0, Math.min(this.bitmap.width - drag.rect.width, drag.rect.x + point.x - drag.start.x)),
				y: Math.max(0, Math.min(this.bitmap.height - drag.rect.height, drag.rect.y + point.y - drag.start.y))
			});
		} else {
			const rect = drag.rect;
			const first = {
				x: drag.handle.includes('w') ? point.x : rect.x,
				y: drag.handle.includes('n') ? point.y : rect.y
			};
			const last = {
				x: drag.handle.includes('e') ? point.x : rect.x + rect.width,
				y: drag.handle.includes('s') ? point.y : rect.y + rect.height
			};
			this.setRegion(screenshotRectangle(first, last));
		}
	}

	private pointerUp(event: PointerEvent): void {
		if (this.drag?.id !== event.pointerId) return;
		this.pointerMove(event);
		if (this.pendingAnnotation) this.annotations.push(this.pendingAnnotation);
		this.pendingAnnotation = undefined;
		this.drag = undefined;
		this.element.classList.remove('dragging');
		if (this.imageArea.hasPointerCapture(event.pointerId)) this.imageArea.releasePointerCapture(event.pointerId);
		this.paint();
		this.render();
		this.announce();
	}

	private annotation(points: readonly ScreenshotPoint[], text?: string): ScreenshotAnnotation {
		return {
			tool: this.tool as Exclude<ScreenshotTool, 'select'>,
			color: this.color.value,
			width: Number(this.lineWidth.value),
			points,
			...(text ? { text } : {})
		};
	}

	private commitText(): void {
		if (!this.textPoint) return;
		if (this.textInput.value.trim())
			this.annotations.push({ ...this.annotation([this.textPoint], this.textInput.value), tool: 'text' });
		this.textPoint = undefined;
		this.textInput.hidden = true;
		this.paint();
		this.announce();
		this.imageArea.focus();
	}

	private selectEntire(): void {
		this.setRegion({ x: 0, y: 0, width: this.bitmap.width, height: this.bitmap.height });
		this.imageArea.focus();
		this.announce();
	}

	private keyDown(event: KeyboardEvent): void {
		if (this.help.open) return;
		if (event.altKey && (event.key === 'F1' || event.key === 'F2')) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.showAccessibleContent(event.key === 'F2');
			return;
		}
		if (event.target === this.textInput) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.complete({ kind: 'cancel' });
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.target === this.imageArea) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.annotations.pop();
			this.paint();
			this.announce();
			return;
		}
		if (event.target !== this.imageArea || this.busy) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.selectEntire();
			return;
		}
		if (event.key === 'Enter' && this.region) {
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.export('attach');
			return;
		}
		if (!this.region || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
		const key = event.shiftKey ? (horizontal ? 'width' : 'height') : horizontal ? 'x' : 'y';
		const delta =
			(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) * (event.ctrlKey || event.metaKey ? 10 : 1);
		this.setRegion({ ...this.region, [key]: this.region[key] + delta });
		this.announce();
	}

	private setRegion(rect: IRectangle): void {
		this.region = clampScreenshotRectangle(rect, this.bitmap.width, this.bitmap.height);
		this.render();
	}

	private paint(): void {
		this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.context.drawImage(this.bitmap, 0, 0);
		for (const annotation of [...this.annotations, ...(this.pendingAnnotation ? [this.pendingAnnotation] : [])])
			paintScreenshotAnnotation(this.context, annotation);
	}

	private render(): void {
		this.selection.hidden = !this.region;
		this.dimensions.hidden = !this.region;
		this.toolbar.hidden = !this.region;
		this.element.classList.toggle('has-selection', !!this.region);
		const viewport = this.document.defaultView!;
		const image = this.canvas.getBoundingClientRect();
		const rect = this.region;
		const left = rect ? image.left + (rect.x * image.width) / this.bitmap.width : 0;
		const top = rect ? image.top + (rect.y * image.height) / this.bitmap.height : 0;
		const right = rect ? left + (rect.width * image.width) / this.bitmap.width : 0;
		const bottom = rect ? top + (rect.height * image.height) / this.bitmap.height : 0;
		const masks = rect
			? [
				[0, 0, viewport.innerWidth, top],
				[0, top, left, bottom - top],
				[right, top, viewport.innerWidth - right, bottom - top],
				[0, bottom, viewport.innerWidth, viewport.innerHeight - bottom]
			]
			: [
				[0, 0, viewport.innerWidth, viewport.innerHeight],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0]
			];
		for (const [index, shade] of this.shades.entries()) {
			const [x, y, width, height] = masks[index];
			Object.assign(shade.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
		}
		if (!this.region) return;
		const scaleX = image.width / this.bitmap.width;
		const scaleY = image.height / this.bitmap.height;
		const { x, y, width, height } = this.region;
		Object.assign(this.selection.style, {
			left: `${image.left + x * scaleX}px`,
			top: `${image.top + y * scaleY}px`,
			width: `${width * scaleX}px`,
			height: `${height * scaleY}px`
		});
		this.dimensions.textContent = localize('screenshot.dimensions', '{0} × {1} pixels', width, height);
		Object.assign(this.dimensions.style, {
			left: `${image.left + x * scaleX}px`,
			top: `${Math.max(8, image.top + y * scaleY - 32)}px`
		});
		for (const [key, input] of this.inputs) {
			input.value = String(this.region[key]);
			input.min = key === 'x' || key === 'y' ? '0' : '1';
			input.max = String(
				key === 'x'
					? this.bitmap.width - 1
					: key === 'y'
						? this.bitmap.height - 1
						: key === 'width'
							? this.bitmap.width - x
							: this.bitmap.height - y
			);
		}
		this.positionToolbar();
	}

	private positionToolbar(): void {
		if (!this.region) return;
		const bounds = this.selection.getBoundingClientRect();
		const { innerWidth, innerHeight } = this.document.defaultView!;
		const left = Math.max(
			8,
			Math.min(innerWidth - this.toolbar.offsetWidth - 8, bounds.right - this.toolbar.offsetWidth)
		);
		const below = bounds.bottom + 12;
		const top =
			below + this.toolbar.offsetHeight <= innerHeight - 8
				? below
				: Math.max(
					8,
					Math.min(
						innerHeight - this.toolbar.offsetHeight - 8,
						bounds.top - this.toolbar.offsetHeight - 12
					)
				);
		Object.assign(this.toolbar.style, { left: `${left}px`, top: `${top}px` });
	}

	private describe(): string {
		return this.region
			? localize(
				'screenshot.description',
				'Selected region: X {0}, Y {1}, Width {2}, Height {3} pixels. Annotations: {4}. Image contents are not described.',
				this.region.x,
				this.region.y,
				this.region.width,
				this.region.height,
				this.annotations.length
			)
			: localize(
				'screenshot.noSelection',
				'No region selected. Drag to select a region or choose Entire screen.'
			);
	}

	private announce(): void {
		this.status.textContent = this.describe();
	}

	private showAccessibleContent(summary: boolean): void {
		const focused = this.document.activeElement as HTMLElement;
		this.help.replaceChildren();
		const heading = this.document.createElement('h2');
		heading.textContent = summary
			? localize('screenshot.summary', 'Screenshot selection')
			: localize('screenshot.helpTitle', 'Screenshot Help');
		this.help.setAttribute('aria-label', heading.textContent);
		const content = this.document.createElement('textarea');
		content.readOnly = true;
		content.value = summary ? this.describe() : getScreenshotAccessibilityHelp();
		content.setAttribute('aria-label', heading.textContent);
		const close = this.document.createElement('button');
		close.textContent = localize('screenshot.closeHelp', 'Close help');
		this.helpListeners.clear();
		this.helpListeners.add(addDisposableListener(close, 'click', () => this.help.close()));
		this.helpListeners.add(addDisposableListener(
			this.help,
			'close',
			() => {
				this.helpListeners.clear();
				if (focused.isConnected) focused.focus();
			},
			{ once: true }
		));
		this.help.append(heading, content, close);
		this.help.showModal();
		content.focus();
	}

	private async export(kind: 'attach' | 'copy' | 'save'): Promise<void> {
		if (!this.region || this.busy) return;
		this.commitText();
		const { x, y, width, height } = this.region;
		const output = this.document.createElement('canvas');
		output.width = width;
		output.height = height;
		output.getContext('2d')!.drawImage(this.canvas, x, y, width, height, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
		if (blob && !this.isDisposed) await this.complete({ kind, image: new Uint8Array(await blob.arrayBuffer()) });
	}

	private async complete(result: ScreenshotCompletion): Promise<void> {
		if (this.busy || this.isDisposed) return;
		this.busy = true;
		this.element.setAttribute('aria-busy', 'true');
		for (const control of this.controls) control.disabled = true;
		try {
			if (await this.options.complete(result)) this.dispose();
		} catch (error) {
			if (!this.isDisposed)
				this.status.textContent = localize('screenshot.failed', 'Screenshot action failed: {0}', String(error));
		} finally {
			this.busy = false;
			if (!this.isDisposed) {
				this.element.setAttribute('aria-busy', 'false');
				for (const control of this.controls) control.disabled = false;
			}
		}
	}
}

/** Copy only the tokens consumed by this surface; the owning workbench remains the theme authority. */
export function screenshotStyles(document: Document): Readonly<Record<string, string>> {
	const root = document.querySelector('.ash-workbench') ?? document.documentElement;
	const computed = document.defaultView!.getComputedStyle(root);
	const properties = [
		'foreground',
		'editor-background',
		'widget-shadow',
		'menu-background',
		'screenshot-maskBackground',
		'widget-border',
		'focusBorder',
		'contrastBorder',
		'shadow-lg',
		'input-background',
		'input-foreground',
		'input-border',
		'toolbar-hoverBackground',
		'button-foreground',
		'button-background',
		'strokeThickness',
		'cornerRadius-small',
		'cornerRadius-large',
		'fontSize-body1',
		'fontSize-label1',
		'fontSize-heading3',
		'spacing-size40',
		'spacing-size80',
		'spacing-size120',
		'spacing-size160'
	];
	return Object.fromEntries(
		properties.map((property) => [`--ash-${property}`, computed.getPropertyValue(`--ash-${property}`)])
	);
}

/** Browser sharing still requires the browser's picker; the frozen-image interaction is shared with Desktop. */
export function captureBrowserScreenshot(
	document: Document,
	capture: () => Promise<Uint8Array | undefined>,
	signal: AbortSignal,
	accessibilityHints: boolean
): Promise<Uint8Array | undefined> {
	return new Promise((resolve, reject) => {
		let editor: ScreenshotEditor | undefined;
		let finished = false;
		const finish = (image?: Uint8Array, error?: unknown): void => {
			if (finished) return;
			finished = true;
			cancellation.dispose();
			editor?.dispose();
			if (error) reject(error);
			else resolve(image);
		};
		const cancel = (): void => finish();
		const cancellation = addDisposableListener(signal, 'abort', cancel, { once: true });
		const open = async (): Promise<void> => {
			try {
				const image = await capture();
				if (finished) return;
				if (!image) {
					finish();
					return;
				}
				const next = await ScreenshotEditor.create(document, image, {
					accessibilityHints,
					complete: async (result) => {
						if (result.kind === 'retake') {
							editor?.dispose();
							editor = undefined;
							// Remove the old overlay from the compositor before taking another frame.
							await new Promise<void>((resolvePaint) =>
								document.defaultView!.requestAnimationFrame(() =>
									document.defaultView!.requestAnimationFrame(() => resolvePaint())
								)
							);
							if (!finished) void open();
							return true;
						}
						if (result.kind === 'copy')
							await document.defaultView!.navigator.clipboard.write([
								new ClipboardItem({
									'image/png': new Blob([new Uint8Array(result.image)], { type: 'image/png' })
								})
							]);
						if (result.kind === 'save') {
							const url = URL.createObjectURL(
								new Blob([new Uint8Array(result.image)], { type: 'image/png' })
							);
							const link = document.createElement('a');
							link.href = url;
							link.download = 'Screenshot.png';
							link.click();
							setTimeout(() => URL.revokeObjectURL(url), 1000);
						}
						finish(result.kind === 'attach' ? result.image : undefined);
						return true;
					}
				});
				if (finished) {
					next.dispose();
					return;
				}
				editor = next;
				for (const [key, value] of Object.entries(screenshotStyles(document)))
					editor.element.style.setProperty(key, value);
				const root = document.querySelector('.ash-workbench');
				editor.element.dataset.colorScheme = root?.getAttribute('data-color-scheme') ?? 'dark';
			} catch (error) {
				finish(undefined, error);
			}
		};
		if (signal.aborted) finish();
		else void open();
	});
}
