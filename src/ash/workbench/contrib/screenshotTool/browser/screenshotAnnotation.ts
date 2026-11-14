import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import './media/screenshotAnnotation.css';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import iconManifest from './media/icons.json' with { type: 'json' };
import type { ScreenshotToolCompletion as ScreenshotCompletion } from './screenshotTool.js';
import { ScreenshotAnnotationControls } from './screenshotAnnotationControls.js';
import { clampScreenshotRectangle, screenshotRectangle, type IScreenshotRect as IRectangle } from './screenshotSelection.js';

const SCREENSHOT_MAX_PIXELS = 16_777_216;
const WINDOW_CLICK_DRAG_THRESHOLD = 4;
const iconGlyphs = new Map(iconManifest.glyphs.map(icon => [icon.id, String.fromCodePoint(parseInt(icon.unicode, 16))]));
const screenshotIcons = {
	select: Lxicon.cursor,
	rectangle: Lxicon.square,
	arrow: Lxicon.arrowRight,
	pen: Lxicon.pen,
	text: Lxicon.text2,
	mosaic: Lxicon.layout,
	undo: Lxicon.discard,
	coordinates: Lxicon.frame,
	help: Lxicon.question,
	retake: Lxicon.refresh,
	cancel: Lxicon.close,
	save: Lxicon.save,
	copy: Lxicon.copy,
	attach: Lxicon.chat,
	entire: Lxicon.screenFull,
	download: Lxicon.download,
	check: Lxicon.check,
	shape: Lxicon.shape,
	'arrow-up-right': Lxicon.arrowUpRight,
	'edit-line': Lxicon.editLine,
	pixelate: Lxicon.mosaic,
};
type ScreenshotIcon = keyof typeof screenshotIcons;

interface ScreenshotPoint {
	readonly x: number;
	readonly y: number;
}
type ScreenshotTool = 'select' | 'rectangle' | 'shape' | 'arrow' | 'pen' | 'text' | 'mosaic';
interface ScreenshotAnnotation {
	readonly tool: Exclude<ScreenshotTool, 'select' | 'shape'> | 'ellipse' | 'line';
	readonly points: readonly ScreenshotPoint[];
	readonly color: string;
	readonly width: number;
	readonly filled?: boolean;
	readonly fontSize?: number;
	readonly text?: string;
}

/** Draw in source pixels so preview and export use the same annotation operations. */
function paintScreenshotAnnotation(context: CanvasRenderingContext2D, annotation: ScreenshotAnnotation): void {
	const [start] = annotation.points;
	const end = annotation.points.at(-1)!;
	context.save();
	context.strokeStyle = annotation.color;
	context.fillStyle = annotation.color;
	context.lineWidth = annotation.width;
	context.lineCap = 'round';
	context.lineJoin = 'round';
	if (annotation.tool === 'mosaic') {
		const rect = screenshotRectangle(start, end);
		// Pixelate the current image, including earlier marks, without exposing the original under the patch.
		const patch = context.canvas.ownerDocument.createElement('canvas');
		patch.width = Math.max(1, Math.ceil(rect.width / 14));
		patch.height = Math.max(1, Math.ceil(rect.height / 14));
		patch
			.getContext('2d')!
			.drawImage(context.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, patch.width, patch.height);
		context.imageSmoothingEnabled = false;
		context.drawImage(patch, 0, 0, patch.width, patch.height, rect.x, rect.y, rect.width, rect.height);
	} else if (annotation.tool === 'rectangle' || annotation.tool === 'ellipse') {
		const rect = screenshotRectangle(start, end);
		context.beginPath();
		if (annotation.tool === 'rectangle') {
			context.rect(rect.x, rect.y, rect.width, rect.height);
		} else {
			const rx = rect.width / 2;
			const ry = rect.height / 2;
			context.ellipse(rect.x + rx, rect.y + ry, rx, ry, 0, 0, 2 * Math.PI);
		}
		if (annotation.filled) context.fill();
		else context.stroke();
	} else if (annotation.tool === 'text') {
		context.font = `${annotation.fontSize ?? Math.max(18, annotation.width * 6)}px sans-serif`;
		context.textBaseline = 'top';
		context.fillText(annotation.text ?? '', start.x, start.y);
	} else {
		context.beginPath();
		context.moveTo(start.x, start.y);
		for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y);
		context.stroke();
		if (annotation.tool === 'arrow') {
			const angle = Math.atan2(end.y - start.y, end.x - start.x);
			const length = Math.max(12, annotation.width * 4);
			context.beginPath();
			context.moveTo(
				end.x - length * Math.cos(angle - Math.PI / 6),
				end.y - length * Math.sin(angle - Math.PI / 6)
			);
			context.lineTo(end.x, end.y);
			context.lineTo(
				end.x - length * Math.cos(angle + Math.PI / 6),
				end.y - length * Math.sin(angle + Math.PI / 6)
			);
			context.stroke();
		}
	}
	context.restore();
}



interface ScreenshotAnnotationEditorOptions {
	readonly agentWindow?: boolean;
	readonly container: HTMLElement;
	readonly appearance: Readonly<Record<string, string>>;
	readonly colorScheme: string;
	readonly windowBounds?: readonly IRectangle[];
	readonly defaultAction: 'copy' | 'attach';
	readonly canRetake: boolean;
	readonly canPin?: boolean;
	readonly accessibilityHints: boolean;
	readonly help: string;
	readonly selectEntire?: boolean;
	readonly description?: string;
	/** False keeps the editor open, for example after cancelling the save dialog. */
	readonly complete: (result: ScreenshotCompletion) => Promise<boolean>;
}

type Drag = {
	readonly id: number;
	readonly start: ScreenshotPoint;
	readonly rect: IRectangle | undefined;
	readonly handle: string;
	windowClick?: { readonly bounds: IRectangle; readonly clientX: number; readonly clientY: number; };
	points: ScreenshotPoint[];
};

/** One frozen image, one selection and one ordered annotation history own both preview and export. */
export class ScreenshotAnnotationEditor extends Disposable {
	readonly element: HTMLDialogElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly imageArea: HTMLElement;
	private readonly selection: HTMLElement;
	private readonly dimensions: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly toolbarStack: HTMLElement;
	private readonly annotationControls?: ScreenshotAnnotationControls;
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
	private hoveredWindow: IRectangle | undefined;
	private annotations: ScreenshotAnnotation[] = [];
	private tool: ScreenshotTool = 'select';
	private drag: Drag | undefined;
	private textPoint: ScreenshotPoint | undefined;
	private busy = false;
	private pendingAnnotation: ScreenshotAnnotation | undefined;

	private constructor(
		document: Document,
		bitmap: ImageBitmap,
		private readonly options: ScreenshotAnnotationEditorOptions
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
		this.element.classList.toggle('ash-screenshot-neutral', options.agentWindow === true);
		this.element.dataset.colorScheme = options.colorScheme;
		for (const [key, value] of Object.entries(options.appearance)) this.element.style.setProperty(`--snapshot-${key}`, value);
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
		this.toolbar.setAttribute('role', options.agentWindow ? 'toolbar' : 'group');
		this.toolbar.setAttribute('aria-label', localize('screenshot.tools', 'Screenshot tools'));
		this.toolbar.hidden = true;
		this.toolbarStack = this.toolbar;
		if (options.agentWindow) {
			this.annotationControls = this._register(new ScreenshotAnnotationControls(document));
			this.toolbarStack = node('div', 'ash-screenshot-toolbar-stack');
			this.toolbarStack.append(this.toolbar, this.annotationControls.element);
		}
		const button = (parent: HTMLElement, label: string, icon: ScreenshotIcon | undefined, run: () => void, primary = false): HTMLButtonElement => {
			if (options.agentWindow) {
				const control = this._register(new Button(parent, {
					label: icon ? '' : label,
					ariaLabel: label,
					icon: icon && screenshotIcons[icon],
					iconOnly: !!icon,
					presentation: primary ? 'primary' : 'quiet',
					onClick: run,
				})).domNode;
				// The editor sits in the dialog top layer, above Workbench's managed hover container.
				control.title = label;
				control.classList.add('ash-screenshot-icon-button');
				if (!icon) control.classList.add('ash-screenshot-text-button');
				this.controls.push(control);
				return control;
			}
			const element = node('button', 'ash-screenshot-icon-button');
			element.type = 'button';
			element.setAttribute('aria-label', label);
			element.title = label;
			if (icon) {
				const glyph = node('span', 'ash-screenshot-icon');
				glyph.setAttribute('aria-hidden', 'true');
				glyph.dataset.icon = icon;
				glyph.dataset.glyph = iconGlyphs.get(icon)!;
				element.append(glyph);
			} else {
				element.textContent = label;
				element.classList.add('ash-screenshot-text-button');
			}
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
			shape: localize('screenshot.shape', 'Shape'),
			arrow: localize('screenshot.arrow', 'Arrow'),
			pen: localize('screenshot.pen', 'Pen'),
			text: localize('screenshot.text', 'Text'),
			mosaic: localize('screenshot.mosaic', 'Mosaic')
		};
		const annotationTools = options.agentWindow
			? [['shape', 'shape'], ['arrow', 'arrow-up-right'], ['pen', 'edit-line'], ['text', 'text'], ['mosaic', 'pixelate']] as const
			: [['select', 'select'], ['rectangle', 'rectangle'], ['arrow', 'arrow'], ['pen', 'pen'], ['text', 'text'], ['mosaic', 'mosaic']] as const;
		for (const [tool, icon] of annotationTools) {
			const control = button(tools, toolNames[tool], icon, () => {
				this.selectTool(options.agentWindow && this.tool === tool ? 'select' : tool, !options.agentWindow);
			});
			if (this.annotationControls && tool !== 'mosaic') control.setAttribute('aria-controls', this.annotationControls.element.id);
			this.toolButtons.set(tool, control);
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
		if (!options.agentWindow) tools.append(this.color, this.lineWidth);
		button(tools, localize('screenshot.undo', 'Undo'), 'undo', () => {
			this.annotations.pop();
			this.paint();
			this.announce();
		});
		const actions = node('div', 'ash-screenshot-tool-row');
		button(actions, localize('screenshot.coordinates', 'Coordinates'), 'coordinates', () => {
			this.fields.hidden = !this.fields.hidden;
			this.positionToolbar();
			if (!this.fields.hidden) this.inputs.get('x')!.focus();
		});
		const cancel = () => { void this.complete({ kind: 'cancel' }); };
		if (!options.agentWindow) {
			button(actions, localize('screenshot.helpTitle', 'Screenshot Help'), 'help', () => this.showAccessibleContent(false));
		}
		button(actions, options.canRetake ? localize('screenshot.retake', 'Retake') : localize('screenshot.reset', 'Reset annotations'), 'retake', () => {
			if (options.canRetake) void this.complete({ kind: 'retake' });
			else this.resetAnnotations();
		});
		if (!options.agentWindow) {
			button(actions, localize('screenshot.cancel', 'Cancel'), 'cancel', cancel);
		}
		if (options.canPin) {
			button(actions, localize('screenshot.pin', 'Pin'), undefined, () => { void this.export('pin'); });
		}
		const save = () => { void this.export('save'); };
		const copy = () => { void this.export('copy'); };
		if (options.agentWindow) {
			button(actions, localize('screenshot.download', 'Download Screenshot'), 'download', save);
		} else {
			button(actions, localize('screenshot.save', 'Save'), 'save', save).title = localize('screenshot.saveTitle', 'Save screenshot');
			button(actions, localize('screenshot.copy', 'Copy'), 'copy', copy, options.defaultAction === 'copy');
		}
		button(
			actions,
			localize('chat.screenshot.attach', 'Add to Chat'),
			'attach',
			() => {
				void this.export('attach');
			},
			!options.agentWindow && options.defaultAction === 'attach'
		);
		if (options.agentWindow) {
			const completion = node('div', 'ash-screenshot-tool-row ash-screenshot-completion');
			button(completion, localize('screenshot.cancel', 'Cancel'), 'cancel', cancel).classList.add('ash-screenshot-cancel');
			button(completion, localize('screenshot.copyToClipboard', 'Copy to Clipboard'), 'check', copy).classList.add('ash-screenshot-confirm');
			actions.append(completion);
		}
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
		if (options.agentWindow) {
			this._register(addDisposableListener(this.toolbar, 'keydown', event => {
				if (event.key === 'ArrowDown' && this.annotationControls && !this.annotationControls.element.hidden && this.toolButtons.get(this.tool) === event.target) {
					event.preventDefault();
					event.stopPropagation();
					this.annotationControls.focus();
					return;
				}
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				const buttons = Array.from(this.toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
				const index = buttons.findIndex(button => button === event.target);
				if (index < 0) return;
				event.preventDefault();
				event.stopPropagation();
				const forward = event.key === 'ArrowRight';
				const rtl = this.document.defaultView!.getComputedStyle(this.toolbar).direction === 'rtl';
				buttons[(index + (forward !== rtl ? 1 : -1) + buttons.length) % buttons.length].focus();
			}));
		}
		const hint = node('div', 'ash-screenshot-instructions');
		hint.textContent = options.windowBounds?.length
			? localize('screenshot.windowInstructions', 'Click a window or drag to select a region · Esc to cancel')
			: localize('screenshot.instructions', 'Drag to capture a region · Esc to cancel');
		button(hint, localize('screenshot.entire', 'Entire screen'), 'entire', () => this.selectEntire());
		if (!options.agentWindow) {
			button(hint, localize('screenshot.helpTitle', 'Screenshot Help'), 'help', () => this.showAccessibleContent(false));
		}
		button(hint, localize('screenshot.cancel', 'Cancel'), 'cancel', cancel);
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
			this.toolbarStack,
			this.textInput,
			this.status,
			this.help
		);
		options.container.append(this.element);
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
		this._register(addDisposableListener(this.imageArea, 'pointerleave', () => {
			if (!this.drag) this.previewWindow(undefined);
		}));
		for (const event of ['pointercancel', 'lostpointercapture'] as const) {
			this._register(
				addDisposableListener(this.imageArea, event, () => {
					if (this.drag?.windowClick) this.previewWindow(undefined);
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
		if (options.selectEntire) this.selectEntire();
		this.paint();
		this.element.showModal();
		this.imageArea.focus();
		this.render();
		if (options.accessibilityHints) {
			this.status.textContent = options.windowBounds?.length
				? localize('screenshot.windowHint', 'Screen capture. Use Up or Down Arrow to preview a window. Press Enter to select, or Alt+F1 for help.')
				: localize(
					'screenshot.hint',
					'Screen capture. Drag to select a region, or choose Entire screen. Press Alt+F1 for help.'
				);
		}
	}

	static async create(
		document: Document,
		image: Uint8Array,
		options: ScreenshotAnnotationEditorOptions
	): Promise<ScreenshotAnnotationEditor> {
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: 'image/png' }));
		if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > SCREENSHOT_MAX_PIXELS) {
			bitmap.close();
			throw new Error(localize('chat.screenshot.tooLarge', 'The screenshot is too large to preview.'));
		}
		try {
			return new ScreenshotAnnotationEditor(document, bitmap, options);
		} catch (error) {
			bitmap.close();
			throw error;
		}
	}

	private selectTool(tool: ScreenshotTool, focusSelection = true): void {
		this.commitText();
		this.tool = tool;
		this.element.dataset.tool = tool;
		for (const [candidate, button] of this.toolButtons) {
			button.setAttribute('aria-pressed', String(candidate === tool));
			button.classList.toggle('selected', candidate === tool);
			if (button.hasAttribute('aria-controls')) button.setAttribute('aria-expanded', String(candidate === tool));
		}
		this.annotationControls?.show(tool);
		this.positionToolbar();
		if (focusSelection) this.imageArea.focus();
	}

	private resetAnnotations(): void {
		this.textPoint = undefined;
		this.textInput.hidden = true;
		this.annotations = [];
		this.pendingAnnotation = undefined;
		this.selectTool('select');
		this.paint();
		this.announce();
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
				color: this.annotationControls?.color ?? this.color.value,
			});
			if (this.annotationControls) {
				this.textInput.style.fontSize = `${this.annotationControls.textSize * bounds.width / this.bitmap.width}px`;
			}
			this.textInput.value = '';
			this.textInput.hidden = false;
			this.textInput.focus();
			return;
		}
		const handle =
			(event.target as HTMLElement).dataset.handle ?? (inside && this.tool === 'select' ? 'move' : 'new');
		const window = !this.region ? this.windowAt(event, start) : undefined;
		const windowClick = window ? { bounds: window, clientX: event.clientX, clientY: event.clientY } : undefined;
		this.drag = { id: event.pointerId, start, rect: this.region, handle, windowClick, points: [start] };
		if (this.tool === 'select' || !inside) {
			if (handle === 'new') {
				this.annotations = [];
				this.selectTool('select');
				if (windowClick) this.previewWindow(windowClick.bounds);
				else this.setRegion(screenshotRectangle(start, start));
			}
		} else this.pendingAnnotation = this.annotation([start, start]);
		this.element.classList.add('dragging');
		this.imageArea.setPointerCapture(event.pointerId);
		this.imageArea.focus();
	}

	private pointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag) {
			if (!this.region && this.options.windowBounds?.length) this.previewWindow(this.windowAt(event));
			return;
		}
		if (drag.id !== event.pointerId) return;
		if (drag.windowClick) {
			if (Math.hypot(event.clientX - drag.windowClick.clientX, event.clientY - drag.windowClick.clientY) < WINDOW_CLICK_DRAG_THRESHOLD) return;
			drag.windowClick = undefined;
		}
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
		if (this.drag.windowClick) this.setRegion(this.drag.windowClick.bounds);
		if (this.pendingAnnotation) this.annotations.push(this.pendingAnnotation);
		this.pendingAnnotation = undefined;
		this.drag = undefined;
		this.element.classList.remove('dragging');
		if (this.imageArea.hasPointerCapture(event.pointerId)) this.imageArea.releasePointerCapture(event.pointerId);
		this.paint();
		this.render();
		this.announce();
	}

	private windowAt(event: PointerEvent, point = this.point(event)): IRectangle | undefined {
		if (event.target !== this.canvas && event.target !== this.imageArea) return undefined;
		return this.options.windowBounds?.find(bounds => point.x >= bounds.x && point.x < bounds.x + bounds.width
			&& point.y >= bounds.y && point.y < bounds.y + bounds.height);
	}

	private previewWindow(window: IRectangle | undefined): void {
		if (this.hoveredWindow === window) return;
		this.hoveredWindow = window;
		this.render();
	}

	private annotation(points: readonly ScreenshotPoint[], text?: string): ScreenshotAnnotation {
		const controls = this.annotationControls;
		const tool = this.tool as Exclude<ScreenshotTool, 'select'>;
		return {
			tool: tool === 'shape' ? controls!.drawingShape : tool,
			filled: tool === 'shape' && controls!.fillShape,
			color: controls?.color ?? this.color.value,
			width: controls?.width ?? Number(this.lineWidth.value),
			fontSize: controls?.textSize,
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
		if (this.help.open || this.annotationControls?.colorPickerOpen) return;
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
		const windows = this.options.windowBounds;
		if (!this.region && windows?.length && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.key === 'Enter') {
				this.setRegion(this.hoveredWindow ?? windows[0]);
				this.announce();
			} else {
				const index = this.hoveredWindow ? windows.indexOf(this.hoveredWindow) : -1;
				const next = index === -1 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + windows.length) % windows.length;
				const bounds = windows[next];
				this.previewWindow(bounds);
				this.status.textContent = localize('screenshot.windowPreview', 'Window {0} of {1}. X {2}, Y {3}, width {4}, height {5} pixels. Press Enter to select.',
					next + 1, windows.length, bounds.x, bounds.y, bounds.width, bounds.height);
			}
			return;
		}
		if (event.key === 'Enter' && this.region) {
			event.preventDefault();
			event.stopImmediatePropagation();
			void this.export(this.options.defaultAction);
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
		this.hoveredWindow = undefined;
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
		const rect = this.region ?? this.hoveredWindow;
		this.selection.hidden = !rect;
		this.dimensions.hidden = !rect;
		this.toolbar.hidden = !this.region;
		this.toolbarStack.hidden = !this.region;
		this.element.classList.toggle('has-selection', !!this.region);
		this.element.classList.toggle('previewing-window', !this.region && !!rect);
		const viewport = this.document.defaultView!;
		const image = this.canvas.getBoundingClientRect();
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
		if (!rect) return;
		const scaleX = image.width / this.bitmap.width;
		const scaleY = image.height / this.bitmap.height;
		const { x, y, width, height } = rect;
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
		if (!this.region) return;
		for (const [key, input] of this.inputs) {
			input.value = String(rect[key]);
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
		const { offsetWidth, offsetHeight } = this.toolbarStack;
		const left = Math.max(
			8,
			Math.min(innerWidth - offsetWidth - 8, bounds.right - offsetWidth)
		);
		const below = bounds.bottom + 12;
		const top =
			below + offsetHeight <= innerHeight - 8
				? below
				: Math.max(
					8,
					Math.min(
						innerHeight - offsetHeight - 8,
						bounds.top - offsetHeight - 12
					)
				);
		Object.assign(this.toolbarStack.style, { left: `${left}px`, top: `${top}px` });
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
		content.value = (summary ? this.describe() : this.options.help) + (this.options.description ? '\n' + this.options.description : '');
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

	private async export(kind: 'attach' | 'copy' | 'save' | 'pin'): Promise<void> {
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
