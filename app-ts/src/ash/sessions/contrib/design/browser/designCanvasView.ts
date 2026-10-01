import './media/designCanvas.css';
import { addDisposableListener, getWindow, h, svg, type IDimension } from '../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ConfirmResult, IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import type { ISessionsPageView } from '../../../browser/pages.js';
import { DesignConfiguration } from '../common/designConfiguration.js';
import { DesignDocumentModel, parseDesignDocument, serializeDesignDocument, type DesignPoint, type DesignShape } from '../common/designDocument.js';
import { DesignViewport, hitTestDesignShapes } from '../common/designGeometry.js';

const WHEEL_ZOOM_SENSITIVITY = 0.005;
const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_DISTANCE = 60;
const focusedViews = new WeakMap<Element, DesignCanvasView>();
type GeometryField = 'x' | 'y' | 'width' | 'height' | 'rotation';
type PointerGesture = { readonly pointerId: number; readonly start: DesignPoint; readonly shape: DesignShape | undefined; preview: DesignShape | undefined; last: DesignPoint };

/** Design document editor; document coordinates never depend on its viewport. */
export class DesignCanvasView extends Disposable implements ISessionsPageView {
	public readonly domNode: HTMLElement;
	private readonly model = this._register(new DesignDocumentModel());
	private readonly camera = new DesignViewport();
	private readonly viewport: HTMLElement;
	private readonly world: HTMLElement;
	private readonly shapesDomNode: SVGSVGElement;
	private readonly selectionDomNode: SVGRectElement;
	private readonly renderedShapes = new Map<string, SVGGraphicsElement>();
	private readonly propertiesDomNode: HTMLElement;
	private readonly contentDomNode: HTMLElement;
	private readonly messageDomNode: HTMLElement;
	private readonly zoomDomNode: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private readonly geometryInputs = new Map<GeometryField, HTMLInputElement>();
	private readonly fillInput: HTMLInputElement;
	private readonly createActions: readonly IAction[];
	private selectedId: string | undefined;
	private gesture: PointerGesture | undefined;
	private dimension: IDimension = { width: 0, height: 0 };
	private file: { resource: URI; revision: string } | undefined;
	private savedContent = serializeDesignDocument(this.model.value);
	private isFileOperationRunning = false;

	constructor(
		container: HTMLElement,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IFileService private readonly files: IFileService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section', {
			className: 'ash-sessions-design-view',
			attributes: { role: 'region', 'aria-label': localize('sessions.design.canvas', 'Design canvas'), tabindex: '0' },
		});
		focusedViews.set(this.domNode, this);
		const toolbarDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-tools' });
		this.toolbar = this._register(new WorkbenchToolBar(toolbarDomNode, contextMenus, { ariaLabel: localize('sessions.design.tools', 'Design tools') }));
		this.zoomDomNode = h(ownerDocument, 'span', { className: 'ash-sessions-design-zoom' });
		toolbarDomNode.append(this.zoomDomNode);
		this.viewport = h(ownerDocument, 'div', { className: 'ash-sessions-design-viewport' });
		this.world = h(ownerDocument, 'div', { className: 'ash-sessions-design-world' });
		this.shapesDomNode = svg(ownerDocument, 'svg');
		this.shapesDomNode.classList.add('ash-sessions-design-shapes');
		this.shapesDomNode.setAttribute('aria-hidden', 'true');
		this.selectionDomNode = svg(ownerDocument, 'rect');
		this.selectionDomNode.classList.add('ash-sessions-design-selection');
		this.shapesDomNode.append(this.selectionDomNode);
		this.world.append(this.shapesDomNode);
		this.viewport.append(this.world);
		this.propertiesDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-properties', attributes: { role: 'group', 'aria-label': localize('sessions.design.properties', 'Shape properties') } });
		for (const [field, label] of [
			['x', localize('sessions.design.x', 'X')],
			['y', localize('sessions.design.y', 'Y')],
			['width', localize('sessions.design.width', 'Width')],
			['height', localize('sessions.design.height', 'Height')],
			['rotation', localize('sessions.design.rotation', 'Rotation')],
		] as const) {
			const input = h(ownerDocument, 'input', { properties: { type: 'number', step: 'any' }, attributes: { 'aria-label': label } });
			if (field === 'width' || field === 'height') { input.min = '0.001'; }
			this.geometryInputs.set(field, input);
			this.propertiesDomNode.append(h(ownerDocument, 'label', {}, label, input));
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
					this.model.updateShape({ ...shape, [field]: input.valueAsNumber });
				} else { this.render(); }
			}));
		}
		this.fillInput = h(ownerDocument, 'input', { properties: { type: 'color' }, attributes: { 'aria-label': localize('sessions.design.fill', 'Fill') } });
		this.propertiesDomNode.append(h(ownerDocument, 'label', {}, localize('sessions.design.fill', 'Fill'), this.fillInput));
		this._register(addDisposableListener(this.fillInput, 'change', () => {
			if (this.selectedShape) { this.model.updateShape({ ...this.selectedShape, fill: this.fillInput.value }); }
		}));
		this.contentDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-content', attributes: { 'aria-hidden': 'true' } });
		this.messageDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		this.domNode.append(toolbarDomNode, this.viewport, this.propertiesDomNode, this.messageDomNode, this.contentDomNode);
		this.createActions = [
			this.action('rectangle', localize('sessions.design.rectangle', 'Rectangle'), () => this.addShape('rectangle')),
			this.action('ellipse', localize('sessions.design.ellipse', 'Ellipse'), () => this.addShape('ellipse')),
		];
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('sessionsDesignCanvasFocused', true);
		const active = scopedContext.createKey<boolean>('sessionsDesignCanvasActive', false);
		this._register(addDisposableListener(this.domNode, 'focus', () => active.set(true)));
		this._register(addDisposableListener(this.domNode, 'blur', () => active.set(false)));
		this.updatePointerCursor();
		this.domNode.classList.toggle('pointer-cursor', configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
		this._register(themeService.onDidColorThemeChange(() => this.updatePointerCursor()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DesignConfiguration.usePointerCursor)) {
				this.domNode.classList.toggle('pointer-cursor', configurationService.getValue<boolean>(DesignConfiguration.usePointerCursor));
			}
		}));
		this._register(this.model.onDidChange(() => {
			if (!this.selectedShape) { this.selectedId = undefined; }
			this.render();
		}));
		this._register(addDisposableListener(this.viewport, 'wheel', (event: WheelEvent) => this.handleWheel(event), { passive: false }));
		this._register(addDisposableListener(this.viewport, 'pointerdown', (event: PointerEvent) => this.handlePointerDown(event)));
		this._register(addDisposableListener(this.viewport, 'pointermove', (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(this.viewport, 'pointerup', (event: PointerEvent) => this.finishGesture(event.pointerId, true)));
		this._register(addDisposableListener(this.viewport, 'pointercancel', (event: PointerEvent) => this.finishGesture(event.pointerId, false)));
		this._register(addDisposableListener(this.viewport, 'lostpointercapture', (event: PointerEvent) => this.finishGesture(event.pointerId, false)));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeyDown(event)));
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.isFileOperationRunning || (this.isDirty && this.confirmDiscard()), 'designDocument')));
		// Browser unload cannot await a save dialog. Its synchronous prompt preserves the unsaved document.
		this._register(addDisposableListener(getWindow(this.domNode), 'beforeunload', (event: BeforeUnloadEvent) => {
			if (this.isDirty && !lifecycle.willShutdown) { event.preventDefault(); event.returnValue = ''; }
		}));
		this.render();
		this.applyTransform();
	}

	public focus(): void { this.domNode.focus(); }
	public layout(dimension: IDimension): void { this.dimension = dimension; }

	public static getFocused(element: HTMLElement): DesignCanvasView | undefined {
		const root = element.closest('.ash-sessions-design-view');
		return root ? focusedViews.get(root) : undefined;
	}

	public getAccessibleContent(): string { return this.contentDomNode.textContent!; }
	public undo(): void { if (this.isFileOperationRunning) { return; } this.cancelGesture(); this.model.undo(); }
	public redo(): void { if (this.isFileOperationRunning) { return; } this.cancelGesture(); this.model.redo(); }

	private get selectedShape(): DesignShape | undefined { return this.model.value.shapes.find(shape => shape.id === this.selectedId); }
	private get isDirty(): boolean { return serializeDesignDocument(this.model.value) !== this.savedContent; }

	private action(id: string, label: string, run: () => unknown, enabled = true): IAction {
		return { id: `sessions.design.${id}`, label, tooltip: label, enabled, run };
	}

	private addShape(kind: DesignShape['kind']): void {
		if (this.isFileOperationRunning) { return; }
		this.cancelGesture();
		this.selectedId = this.model.addShape(kind, this.camera.toWorld({ x: this.dimension.width / 2, y: this.viewport.clientHeight / 2 }));
		this.render();
		this.focus();
	}

	private renderShapes(): void {
		const shapes = this.model.value.shapes;
		const ids = new Set(shapes.map(shape => shape.id));
		for (const [id, element] of this.renderedShapes) {
			if (!ids.has(id)) { element.remove(); this.renderedShapes.delete(id); }
		}
		for (const committedShape of shapes) {
			const shape = this.gesture?.preview?.id === committedShape.id ? this.gesture.preview : committedShape;
			let element = this.renderedShapes.get(shape.id);
			if (element && element.tagName !== (shape.kind === 'ellipse' ? 'ellipse' : 'rect')) {
				element.remove();
				element = undefined;
			}
			if (!element) {
				element = svg(this.shapesDomNode.ownerDocument, shape.kind === 'ellipse' ? 'ellipse' : 'rect');
				element.dataset.shapeId = shape.id;
				this.renderedShapes.set(shape.id, element);
			}
			if (shape.kind === 'ellipse') {
				element.setAttribute('cx', `${shape.x + shape.width / 2}`);
				element.setAttribute('cy', `${shape.y + shape.height / 2}`);
				element.setAttribute('rx', `${shape.width / 2}`);
				element.setAttribute('ry', `${shape.height / 2}`);
			} else {
				for (const key of ['x', 'y', 'width', 'height'] as const) { element.setAttribute(key, `${shape[key]}`); }
			}
			element.setAttribute('fill', shape.fill);
			element.setAttribute('transform', this.shapeTransform(shape));
			this.shapesDomNode.insertBefore(element, this.selectionDomNode);
		}
		const selected = this.gesture?.preview ?? this.selectedShape;
		this.selectionDomNode.classList.toggle('visible', !!selected);
		this.propertiesDomNode.classList.toggle('visible', !!selected);
		if (selected) {
			for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
				const input = this.geometryInputs.get(field)!;
				input.value = `${selected[field]}`;
				input.disabled = this.isFileOperationRunning;
				if (field !== 'rotation') { this.selectionDomNode.setAttribute(field, `${selected[field]}`); }
			}
			this.fillInput.value = selected.fill;
			this.fillInput.disabled = this.isFileOperationRunning;
			this.selectionDomNode.setAttribute('transform', this.shapeTransform(selected));
		}
	}

	private render(): void {
		this.renderShapes();
		const shapes = this.model.value.shapes;
		const selected = this.selectedShape;
		this.toolbar.setActions([
			...(this.isFileOperationRunning ? this.createActions.map(action => ({ ...action, enabled: false })) : this.createActions),
			this.action('undo', localize('sessions.design.undo', 'Undo'), () => this.undo(), !this.isFileOperationRunning && this.model.canUndo),
			this.action('redo', localize('sessions.design.redo', 'Redo'), () => this.redo(), !this.isFileOperationRunning && this.model.canRedo),
			this.action('delete', localize('sessions.design.delete', 'Delete'), () => this.deleteSelected(), !this.isFileOperationRunning && !!selected),
			this.action('open', localize('sessions.design.open', 'Open design'), () => this.openDocument(), !this.isFileOperationRunning),
			this.action('save', localize('sessions.design.save', 'Save design'), () => this.saveDocument(), !this.isFileOperationRunning),
		]);
		this.contentDomNode.textContent = shapes.length === 0 ? localize('sessions.design.empty', 'The design document is empty.') : shapes.map((shape, index) => localize('sessions.design.shapeDescription', '{0}. {1}: X {2}, Y {3}, width {4}, height {5}, rotation {6} degrees, fill {7}', index + 1, shape.kind === 'ellipse' ? localize('sessions.design.ellipse', 'Ellipse') : localize('sessions.design.rectangle', 'Rectangle'), shape.x, shape.y, shape.width, shape.height, shape.rotation, shape.fill)).join('\n');
		this.domNode.classList.toggle('dirty', this.isDirty);
		this.updateZoomLabel();
	}

	private shapeTransform(shape: DesignShape): string {
		return `rotate(${shape.rotation} ${shape.x + shape.width / 2} ${shape.y + shape.height / 2})`;
	}

	private updatePointerCursor(): void {
		const color = this.themeService.getColorTheme().getColorCss(foreground)!;
		const svg = getLxiconDefinition(Lxicon.cursor.id)!().replace('<svg ', '<svg width="24" height="24" ').replaceAll('#000', color);
		// The hotspot follows the artwork's tip at (3.5, 3) in its 16-unit viewBox.
		this.domNode.style.setProperty('--ash-sessions-design-pointer-cursor', `url("data:image/svg+xml,${encodeURIComponent(svg)}") 5 4, default`);
	}

	private handleWheel(event: WheelEvent): void {
		if (this.gesture) { event.preventDefault(); return; }
		const wheel = new StandardWheelEvent(event);
		if (wheel.ctrlKey || wheel.metaKey) { this.camera.zoomAt(this.viewportPoint(event), Math.exp(-wheel.deltaY * WHEEL_ZOOM_SENSITIVITY)); }
		else { this.camera.panBy(-wheel.deltaX, -wheel.deltaY); }
		this.applyTransform();
		wheel.stop();
	}

	private viewportPoint(event: MouseEvent): DesignPoint {
		const bounds = this.viewport.getBoundingClientRect();
		return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
	}

	private handlePointerDown(event: PointerEvent): void {
		if (this.isFileOperationRunning || (event.button !== 0 && event.button !== 1) || !event.isPrimary || this.gesture) { return; }
		const point = this.viewportPoint(event);
		const shape = event.button === 1 ? undefined : hitTestDesignShapes(this.model.value.shapes, this.camera.toWorld(point));
		this.selectedId = shape?.id;
		this.gesture = { pointerId: event.pointerId, start: point, shape, preview: shape, last: point };
		this.viewport.setPointerCapture(event.pointerId);
		this.domNode.classList.add(shape ? 'moving' : 'panning');
		this.render();
		this.focus();
		event.preventDefault();
	}

	private handlePointerMove(event: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) { return; }
		const point = this.viewportPoint(event);
		if (gesture.shape) {
			gesture.preview = { ...gesture.shape, x: gesture.shape.x + (point.x - gesture.start.x) / this.camera.scale, y: gesture.shape.y + (point.y - gesture.start.y) / this.camera.scale };
			this.renderShapes();
		} else {
			this.camera.panBy(point.x - gesture.last.x, point.y - gesture.last.y);
			this.applyTransform();
		}
		gesture.last = point;
	}

	private finishGesture(pointerId: number, commit: boolean): void {
		const gesture = this.gesture;
		if (!gesture || pointerId !== gesture.pointerId) { return; }
		this.gesture = undefined;
		if (this.viewport.hasPointerCapture(pointerId)) { this.viewport.releasePointerCapture(pointerId); }
		this.domNode.classList.remove('panning', 'moving');
		if (commit && gesture.preview) { this.model.updateShape(gesture.preview); }
		this.render();
	}

	private cancelGesture(): void {
		if (this.gesture) { this.finishGesture(this.gesture.pointerId, false); }
	}

	private deleteSelected(): void {
		if (this.isFileOperationRunning) { return; }
		this.cancelGesture();
		if (this.selectedId) { this.model.removeShape(this.selectedId); }
		this.focus();
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.target !== this.domNode || this.isFileOperationRunning) { return; }
		if (event.key === 'Escape') { this.cancelGesture(); this.selectedId = undefined; this.render(); event.preventDefault(); return; }
		if (this.gesture) { return; }
		if (event.ctrlKey || event.metaKey) { return; }
		const shape = this.selectedShape;
		const distance = event.shiftKey ? 10 : 1;
		const directions: Record<string, DesignPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
		const direction = directions[event.key];
		if (direction) {
			if (shape) { this.model.updateShape({ ...shape, x: shape.x + direction.x * distance, y: shape.y + direction.y * distance }); }
			else { this.camera.panBy(-direction.x * KEYBOARD_PAN_DISTANCE, -direction.y * KEYBOARD_PAN_DISTANCE); this.applyTransform(); }
		} else {
			switch (event.key.toLowerCase()) {
				case 'r': this.addShape('rectangle'); break;
				case 'e': this.addShape('ellipse'); break;
				case 'delete': case 'backspace': this.deleteSelected(); break;
				case 'tab': {
					const shapes = this.model.value.shapes;
					const index = shapes.findIndex(item => item.id === this.selectedId);
					const next = index + (event.shiftKey ? -1 : 1);
					if (next < 0 || next >= shapes.length) { return; }
					this.selectedId = shapes[next].id;
					this.render();
					break;
				}
				case '=': case '+': this.zoomAtCenter(KEYBOARD_ZOOM_FACTOR); break;
				case '-': case '_': this.zoomAtCenter(1 / KEYBOARD_ZOOM_FACTOR); break;
				case '0': this.camera.reset(); this.applyTransform(); break;
				default: return;
			}
		}
		event.preventDefault();
	}

	private zoomAtCenter(factor: number): void {
		this.camera.zoomAt({ x: this.dimension.width / 2, y: this.viewport.clientHeight / 2 }, factor);
		this.applyTransform();
	}

	private applyTransform(): void {
		this.world.style.transform = `translate(${this.camera.panX}px, ${this.camera.panY}px) scale(${this.camera.scale})`;
		this.viewport.style.setProperty('--ash-sessions-design-pan-x', `${this.camera.panX}px`);
		this.viewport.style.setProperty('--ash-sessions-design-pan-y', `${this.camera.panY}px`);
		this.viewport.style.setProperty('--ash-sessions-design-scale', `${this.camera.scale}`);
		this.updateZoomLabel();
	}

	private updateZoomLabel(): void {
		this.zoomDomNode.textContent = localize('sessions.design.zoom', '{0}% · 1 unit = 1 px · grid 12 px', Math.round(this.camera.scale * 100)) + (this.isDirty ? ' · ' + localize('sessions.design.unsaved', 'Unsaved changes') : '');
	}

	/** Returns a shutdown/open veto, including a cancelled or failed save. */
	private async confirmDiscard(): Promise<boolean> {
		if (this.isFileOperationRunning) { return true; }
		if (!this.isDirty) { return false; }
		this.isFileOperationRunning = true;
		this.render();
		let result: ConfirmResult;
		try {
			result = await this.fileDialogs.showSaveConfirm([this.file ? basename(this.file.resource) : localize('sessions.design.untitled', 'Untitled design')]);
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.render(); }
		}
		if (result === ConfirmResult.CANCEL) { return true; }
		if (result === ConfirmResult.SAVE) { return !(await this.saveDocument()); }
		return false;
	}

	private async openDocument(): Promise<void> {
		this.cancelGesture();
		if (await this.confirmDiscard()) { return; }
		this.isFileOperationRunning = true;
		this.render();
		try {
			const resources = await this.fileDialogs.showOpenDialog({ title: localize('sessions.design.open', 'Open design'), defaultUri: this.file?.resource, canSelectFiles: true, canSelectFolders: false, filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['json'] }] });
			if (!resources || this.isDisposed) { return; }
			const read = await this.files.readFile(resources[0]);
			const document = parseDesignDocument(read.content);
			if (this.isDisposed) { return; }
			this.file = { resource: read.resource, revision: read.revision };
			this.savedContent = serializeDesignDocument(document);
			this.selectedId = undefined;
			this.model.replace(document);
			this.messageDomNode.textContent = localize('sessions.design.opened', 'Opened {0}', basename(read.resource));
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.openFailed', 'Could not open the design.'), String(error));
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.render(); this.focus(); }
		}
	}

	public async saveDocument(): Promise<boolean> {
		if (this.isFileOperationRunning) { return false; }
		this.cancelGesture();
		this.isFileOperationRunning = true;
		this.render();
		try {
			const resource = this.file?.resource ?? await this.fileDialogs.showSaveDialog({ title: localize('sessions.design.save', 'Save design'), defaultUri: this.workspace.getWorkspace().folders[0]?.uri.joinPathSegment('design.ash-design.json'), filters: [{ name: localize('sessions.design.fileType', 'Ash design'), extensions: ['json'] }] });
			if (!resource || this.isDisposed) { return false; }
			const content = serializeDesignDocument(this.model.value);
			const result = await this.files.writeFile({ resource, content, expectedRevision: this.file?.revision });
			if (this.isDisposed) { return false; }
			this.file = { resource, revision: result.revision };
			this.savedContent = content;
			this.messageDomNode.textContent = localize('sessions.design.saved', 'Saved {0}', basename(resource));
			return !this.isDirty;
		} catch (error) {
			await this.dialogs.error(localize('sessions.design.saveFailed', 'Could not save the design. Your changes are still in the canvas.'), String(error));
			return false;
		} finally {
			this.isFileOperationRunning = false;
			if (!this.isDisposed) { this.render(); this.focus(); }
		}
	}
}
