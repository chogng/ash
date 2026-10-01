import './designEditorWidget.css';
import { addDisposableListener, h, svg, type IDimension } from '../../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../../base/common/lxiconsUtil.js';
import { localize } from '../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { foreground } from '../../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { DesignConfiguration } from '../../common/config/editorConfiguration.js';
import type { DesignShape } from '../../common/model/document.js';
import { toDesignLocal, type DesignPoint } from '../../common/core/geometry.js';
import { DocumentCommands } from '../../common/commands/documentCommands.js';
import { DesignSelection } from '../../common/selection.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import { renderDesignShape } from '../svgRenderer.js';
import { DesignViewport } from '../../common/viewport.js';
import { hitTestDesignShapes } from '../../common/model/hitTest.js';

const WHEEL_ZOOM_SENSITIVITY = 0.005;
const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_DISTANCE = 60;
const focusedViews = new WeakMap<Element, DesignEditorWidget>();
type GeometryField = 'x' | 'y' | 'width' | 'height' | 'rotation';
type PathHandle = { readonly nodeIndex: number; readonly point: 'anchor' | 'incoming' | 'outgoing' };
interface PointerGesture {
	readonly pointerId: number;
	readonly start: DesignPoint;
	readonly shapes: readonly DesignShape[];
	readonly handle?: PathHandle;
	preview: readonly DesignShape[];
	last: DesignPoint;
}

/** Design document editor; document coordinates never depend on its viewport. */
export class DesignEditorWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly commands: DocumentCommands;
	private readonly selection = new DesignSelection();
	private readonly camera = new DesignViewport();
	private readonly viewport: HTMLElement;
	private readonly world: HTMLElement;
	private readonly shapesDomNode: SVGSVGElement;
	private readonly selectionDomNode: SVGGElement;
	private readonly renderedShapes = new Map<string, SVGGraphicsElement>();
	private readonly propertiesDomNode: HTMLElement;
	private readonly contentDomNode: HTMLElement;
	private readonly messageDomNode: HTMLElement;
	private readonly zoomDomNode: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private readonly geometryInputs = new Map<GeometryField, HTMLInputElement>();
	private readonly fillInput: HTMLInputElement;
	private readonly createActions: readonly IAction[];
	private readonly textProperties: HTMLElement;
	private readonly textInput: HTMLTextAreaElement;
	private readonly fontSizeInput: HTMLInputElement;
	private readonly pathProperties: HTMLElement;
	private readonly nodeInput: HTMLSelectElement;
	private readonly closedInput: HTMLInputElement;
	private readonly pathInputs = new Map<string, HTMLInputElement>();
	private gesture: PointerGesture | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		container: HTMLElement,
		private readonly documentController: DesignDocumentController,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.commands = new DocumentCommands(documentController.model);
		this.domNode = h(ownerDocument, 'section', { className: 'ash-sessions-design-view', attributes: { role: 'region', 'aria-label': localize('sessions.design.canvas', 'Design canvas'), tabindex: '0' } });
		focusedViews.set(this.domNode, this);
		this._register(toDisposable(() => {
			this.cancelGesture();
			focusedViews.delete(this.domNode);
		}));
		const toolbarDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-tools' });
		this.toolbar = this._register(new WorkbenchToolBar(toolbarDomNode, contextMenus, { ariaLabel: localize('sessions.design.tools', 'Design tools') }));
		this.zoomDomNode = h(ownerDocument, 'span', { className: 'ash-sessions-design-zoom' });
		toolbarDomNode.append(this.zoomDomNode);
		this.viewport = h(ownerDocument, 'div', { className: 'ash-sessions-design-viewport' });
		this.world = h(ownerDocument, 'div', { className: 'ash-sessions-design-world' });
		this.shapesDomNode = svg(ownerDocument, 'svg');
		this.shapesDomNode.classList.add('ash-sessions-design-shapes');
		this.shapesDomNode.setAttribute('aria-hidden', 'true');
		this.selectionDomNode = svg(ownerDocument, 'g');
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
					this.commands.updateGeometry(shape, field, input.valueAsNumber);
				} else { this.render(); }
			}));
		}
		this.fillInput = h(ownerDocument, 'input', { properties: { type: 'color' }, attributes: { 'aria-label': localize('sessions.design.fill', 'Fill') } });
		this.propertiesDomNode.append(h(ownerDocument, 'label', {}, localize('sessions.design.fill', 'Fill'), this.fillInput));
		this._register(addDisposableListener(this.fillInput, 'change', () => {
			if (this.selectedShape) { this.commands.updateShape({ ...this.selectedShape, fill: this.fillInput.value }); }
		}));
		this.textProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
		this.textInput = h(ownerDocument, 'textarea', { attributes: { 'aria-label': localize('sessions.design.textContent', 'Text content'), rows: '2' } });
		this.fontSizeInput = h(ownerDocument, 'input', { properties: { type: 'number', min: '0.001', step: 'any' }, attributes: { 'aria-label': localize('sessions.design.fontSize', 'Font size') } });
		this.textProperties.append(h(ownerDocument, 'label', {}, localize('sessions.design.textContent', 'Text content'), this.textInput), h(ownerDocument, 'label', {}, localize('sessions.design.fontSize', 'Font size'), this.fontSizeInput));
		this._register(addDisposableListener(this.textInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text') { this.commands.updateShape({ ...shape, text: this.textInput.value }); }
		}));
		this._register(addDisposableListener(this.fontSizeInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text' && this.fontSizeInput.checkValidity() && Number.isFinite(this.fontSizeInput.valueAsNumber)) { this.commands.updateShape({ ...shape, fontSize: this.fontSizeInput.valueAsNumber }); }
			else { this.render(); }
		}));
		this.pathProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
		this.nodeInput = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.design.node', 'Path node') } });
		this.closedInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.closed', 'Closed path') } });
		this.pathProperties.append(h(ownerDocument, 'label', {}, localize('sessions.design.node', 'Path node'), this.nodeInput), h(ownerDocument, 'label', {}, localize('sessions.design.closed', 'Closed path'), this.closedInput));
		this._register(addDisposableListener(this.nodeInput, 'change', () => { this.selection.nodeIndex = Number(this.nodeInput.value); this.renderShapes(); }));
		this._register(addDisposableListener(this.closedInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'path') { this.commands.updateShape({ ...shape, closed: this.closedInput.checked }); }
		}));
		for (const [field, label] of [
			['x', localize('sessions.design.anchorX', 'Anchor X')], ['y', localize('sessions.design.anchorY', 'Anchor Y')],
			['incomingX', localize('sessions.design.incomingX', 'Incoming handle X')], ['incomingY', localize('sessions.design.incomingY', 'Incoming handle Y')],
			['outgoingX', localize('sessions.design.outgoingX', 'Outgoing handle X')], ['outgoingY', localize('sessions.design.outgoingY', 'Outgoing handle Y')],
		] as const) {
			const input = h(ownerDocument, 'input', { properties: { type: 'number', min: '0', step: 'any' }, attributes: { 'aria-label': label } });
			this.pathInputs.set(field, input);
			this.pathProperties.append(h(ownerDocument, 'label', {}, label, input));
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind !== 'path' || !input.checkValidity() || !Number.isFinite(input.valueAsNumber)) { this.render(); return; }
				const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
				const value = input.valueAsNumber / (axis === 'x' ? shape.width : shape.height);
				const nodes = shape.nodes.map((node, index) => {
					if (index !== this.selection.nodeIndex) { return node; }
					if (field.startsWith('incoming')) { return { ...node, incoming: { ...node.incoming, [axis]: value } }; }
					if (field.startsWith('outgoing')) { return { ...node, outgoing: { ...node.outgoing, [axis]: value } }; }
					return { ...node, [axis]: value };
				});
				this.commands.updateShape({ ...shape, nodes });
			}));
		}
		this.propertiesDomNode.append(this.textProperties, this.pathProperties);
		this.contentDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-content', attributes: { 'aria-hidden': 'true' } });
		this.messageDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		this.domNode.append(toolbarDomNode, this.viewport, this.propertiesDomNode, this.messageDomNode, this.contentDomNode);
		this.createActions = [
			this.action('rectangle', localize('sessions.design.rectangle', 'Rectangle'), () => this.addShape('rectangle')),
			this.action('ellipse', localize('sessions.design.ellipse', 'Ellipse'), () => this.addShape('ellipse')),
			this.action('text', localize('sessions.design.text', 'Text'), () => this.addShape('text')),
			this.action('path', localize('sessions.design.path', 'Bézier path'), () => this.addShape('path')),
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
		this._register(this.documentController.model.onDidChange(kind => {
			this.cancelGesture();
			if (kind === 'replace') { this.select([]); }
			else if (this.selection.retain(this.documentController.model.value.shapes)) { this.announceSelection(); }
			this.render();
		}));
		this._register(documentController.onDidChange(event => {
			if (documentController.isBusy) { this.cancelGesture(); }
			if (event.message !== undefined) { this.messageDomNode.textContent = event.message; }
			this.render();
		}));
		this._register(addDisposableListener(this.viewport, 'wheel', (event: WheelEvent) => this.handleWheel(event), { passive: false }));
		this._register(addDisposableListener(this.viewport, 'pointerdown', (event: PointerEvent) => this.handlePointerDown(event)));
		this._register(addDisposableListener(this.viewport, 'pointermove', (event: PointerEvent) => this.handlePointerMove(event)));
		this._register(addDisposableListener(this.viewport, 'pointerup', (event: PointerEvent) => this.finishGesture(event.pointerId, true)));
		this._register(addDisposableListener(this.viewport, 'pointercancel', (event: PointerEvent) => this.finishGesture(event.pointerId, false)));
		this._register(addDisposableListener(this.viewport, 'lostpointercapture', (event: PointerEvent) => this.finishGesture(event.pointerId, false)));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeyDown(event)));

	}

	public initialize(): void {
		this.render();
		this.applyTransform();
	}

	public focus(): void { this.domNode.focus(); }
	public layout(dimension: IDimension): void { this.dimension = dimension; }

	public static getFocused(element: HTMLElement): DesignEditorWidget | undefined {
		const root = element.closest('.ash-sessions-design-view');
		return root ? focusedViews.get(root) : undefined;
	}

	public getAccessibleContent(): string { return this.contentDomNode.textContent!; }
	public undo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.undo(); }
	public redo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.redo(); }

	private get selectedShape(): DesignShape | undefined { return this.selection.ids.size === 1 ? this.selectedShapes[0] : undefined; }
	private get selectedShapes(): readonly DesignShape[] { return this.documentController.model.value.shapes.filter(shape => this.selection.ids.has(shape.id)); }

	private select(ids: readonly string[]): void {
		this.selection.set(ids);
		this.announceSelection();
	}

	private announceSelection(): void {
		this.messageDomNode.textContent = localize('sessions.design.selectionCount', '{0} objects selected.', this.selection.ids.size);
	}

	private action(id: string, label: string, run: () => unknown, enabled = true): IAction {
		return { id: `sessions.design.${id}`, label, tooltip: label, enabled, run };
	}

	private addShape(kind: 'rectangle' | 'ellipse' | 'text' | 'path'): void {
		if (this.documentController.isBusy) { return; }
		this.cancelGesture();
		this.select([this.commands.addShape(kind, this.camera.toWorld({ x: this.dimension.width / 2, y: this.viewport.clientHeight / 2 }), localize('sessions.design.text', 'Text'))]);
		this.render();
		this.focus();
	}

	private renderShapes(): void {
		const shapes = this.documentController.model.value.shapes;
		const ids = new Set(shapes.map(shape => shape.id));
		for (const [id, element] of this.renderedShapes) {
			if (!ids.has(id)) { element.remove(); this.renderedShapes.delete(id); }
		}
		for (const committedShape of shapes) {
			const shape = this.gesture?.preview.find(preview => preview.id === committedShape.id) ?? committedShape;
			const previous = this.renderedShapes.get(shape.id);
			const element = renderDesignShape(this.shapesDomNode, shape, previous);
			if (previous !== element) { previous?.remove(); this.renderedShapes.set(shape.id, element); }
			this.shapesDomNode.insertBefore(element, this.selectionDomNode);
		}
		const selected = this.gesture?.preview.length ? this.gesture.preview : this.selectedShapes;
		this.selectionDomNode.replaceChildren(...selected.map(shape => {
			const rect = svg(this.selectionDomNode.ownerDocument, 'rect');
			for (const key of ['x', 'y', 'width', 'height'] as const) { rect.setAttribute(key, `${shape[key]}`); }
			rect.setAttribute('transform', this.shapeTransform(shape));
			return rect;
		}));
		if (selected.length === 1 && selected[0].kind === 'path') {
			const path = selected[0];
			const handles = svg(this.selectionDomNode.ownerDocument, 'g');
			handles.setAttribute('transform', this.shapeTransform(path));
			for (const [index, node] of path.nodes.entries()) {
				for (const point of ['incoming', 'outgoing', 'anchor'] as const) {
					const position = point === 'anchor' ? node : node[point];
					if (point !== 'anchor' && position.x === node.x && position.y === node.y) { continue; }
					if (point !== 'anchor') {
						const line = svg(handles.ownerDocument, 'line');
						for (const [key, value] of Object.entries({ x1: path.x + node.x * path.width, y1: path.y + node.y * path.height, x2: path.x + position.x * path.width, y2: path.y + position.y * path.height })) { line.setAttribute(key, `${value}`); }
						handles.append(line);
					}
					const circle = svg(handles.ownerDocument, 'circle');
					circle.classList.add('ash-sessions-design-path-handle');
					circle.dataset.pathNode = `${index}`;
					circle.dataset.pathPoint = point;
					circle.setAttribute('cx', `${path.x + position.x * path.width}`);
					circle.setAttribute('cy', `${path.y + position.y * path.height}`);
					circle.setAttribute('r', `${(point === 'anchor' ? 5 : 4) / this.camera.scale}`);
					handles.append(circle);
				}
			}
			this.selectionDomNode.append(handles);
		}
		this.selectionDomNode.classList.toggle('visible', selected.length > 0);
		const shape = selected.length === 1 ? selected[0] : undefined;
		this.propertiesDomNode.classList.toggle('visible', !!shape);
		this.textProperties.classList.toggle('visible', shape?.kind === 'text');
		this.pathProperties.classList.toggle('visible', shape?.kind === 'path');
		if (!shape) { return; }
		for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
			const input = this.geometryInputs.get(field)!;
			input.value = `${shape[field]}`;
			input.disabled = this.documentController.isBusy;
		}
		this.fillInput.value = shape.fill;
		this.fillInput.disabled = this.documentController.isBusy || shape.kind === 'group';
		if (shape.kind === 'text') {
			this.textInput.value = shape.text;
			this.fontSizeInput.value = `${shape.fontSize}`;
			this.textInput.disabled = this.fontSizeInput.disabled = this.documentController.isBusy;
		}
		if (shape.kind === 'path') {
			this.selection.nodeIndex = Math.min(this.selection.nodeIndex, shape.nodes.length - 1);
			if (this.nodeInput.options.length !== shape.nodes.length) {
				this.nodeInput.replaceChildren(...shape.nodes.map((_, index) => h(this.domNode.ownerDocument, 'option', { properties: { value: `${index}` } }, `${index + 1}`)));
			}
			this.nodeInput.value = `${this.selection.nodeIndex}`;
			this.closedInput.checked = shape.closed;
			this.nodeInput.disabled = this.closedInput.disabled = this.documentController.isBusy;
			const node = shape.nodes[this.selection.nodeIndex];
			for (const [field, input] of this.pathInputs) {
				const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
				let point: DesignPoint = node;
				if (field.startsWith('incoming')) { point = node.incoming; }
				if (field.startsWith('outgoing')) { point = node.outgoing; }
				const dimension = axis === 'x' ? shape.width : shape.height;
				input.value = `${point[axis] * dimension}`;
				input.max = `${dimension}`;
				input.disabled = this.documentController.isBusy;
			}
		}
	}

	private render(): void {
		this.renderShapes();
		const shapes = this.documentController.model.value.shapes;
		const selected = this.selectedShape;
		this.toolbar.setActions([
			...(this.documentController.isBusy ? this.createActions.map(action => ({ ...action, enabled: false })) : this.createActions),
			this.action('undo', localize('sessions.design.undo', 'Undo'), () => this.undo(), !this.documentController.isBusy && this.documentController.model.canUndo),
			this.action('redo', localize('sessions.design.redo', 'Redo'), () => this.redo(), !this.documentController.isBusy && this.documentController.model.canRedo),
			this.action('delete', localize('sessions.design.delete', 'Delete'), () => this.deleteSelected(), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('selectAll', localize('sessions.design.selectAll', 'Select all'), () => { this.select(shapes.map(shape => shape.id)); this.render(); this.focus(); }, !this.documentController.isBusy && shapes.length > 0),
			this.action('group', localize('sessions.design.group', 'Group'), () => this.groupSelected(), !this.documentController.isBusy && this.selection.ids.size > 1),
			this.action('ungroup', localize('sessions.design.ungroup', 'Ungroup'), () => this.ungroupSelected(), !this.documentController.isBusy && selected?.kind === 'group'),
			...(selected?.kind === 'path' ? [
				this.action('addNode', localize('sessions.design.addNode', 'Add node'), () => this.addPathNode(), !this.documentController.isBusy),
				this.action('removeNode', localize('sessions.design.removeNode', 'Remove node'), () => this.removePathNode(), !this.documentController.isBusy && selected.nodes.length > 2),
			] : []),
			this.action('export', localize('sessions.design.export', 'Export SVG'), () => this.runFileOperation(() => this.documentController.exportDocument()), !this.documentController.isBusy && shapes.length > 0),
			this.action('open', localize('sessions.design.open', 'Open design'), () => this.runFileOperation(() => this.documentController.openDocument()), !this.documentController.isBusy),
			this.action('save', localize('sessions.design.save', 'Save design'), () => this.saveDocument(), !this.documentController.isBusy),
		]);
		const describe = (shape: DesignShape, index: number): string => {
			const labels = {
				rectangle: localize('sessions.design.rectangle', 'Rectangle'),
				ellipse: localize('sessions.design.ellipse', 'Ellipse'),
				text: localize('sessions.design.text', 'Text'),
				path: localize('sessions.design.path', 'Bézier path'),
				group: localize('sessions.design.group', 'Group'),
			};
			let content = localize('sessions.design.shapeDescription', '{0}. {1}: X {2}, Y {3}, width {4}, height {5}, rotation {6} degrees, fill {7}', index + 1, labels[shape.kind], shape.x, shape.y, shape.width, shape.height, shape.rotation, shape.fill);
			if (this.selection.ids.has(shape.id)) { content += ' · ' + localize('sessions.design.selected', 'Selected'); }
			if (shape.kind === 'text') { content += `\n${shape.text}`; }
			if (shape.kind === 'path') { content += '\n' + localize('sessions.design.pathDescription', '{0} nodes; closed: {1}', shape.nodes.length, shape.closed ? localize('sessions.design.yes', 'Yes') : localize('sessions.design.no', 'No')); }
			if (shape.kind === 'group') { content += '\n' + shape.children.map(describe).join('\n'); }
			return content;
		};
		this.contentDomNode.textContent = shapes.length === 0 ? localize('sessions.design.empty', 'The design document is empty.') : shapes.map(describe).join('\n');
		this.domNode.classList.toggle('dirty', this.documentController.isDirty);
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
		if (this.documentController.isBusy || (event.button !== 0 && event.button !== 1) || !event.isPrimary || this.gesture) { return; }
		const point = this.viewportPoint(event);
		const target = event.target as Element;
		const path = this.selectedShape;
		if (event.button === 0 && target.classList.contains('ash-sessions-design-path-handle') && path?.kind === 'path') {
			const handle: PathHandle = { nodeIndex: Number(target.getAttribute('data-path-node')), point: target.getAttribute('data-path-point') as PathHandle['point'] };
			this.selection.nodeIndex = handle.nodeIndex;
			this.gesture = { pointerId: event.pointerId, start: point, shapes: [path], preview: [path], last: point, handle };
			this.viewport.setPointerCapture(event.pointerId);
			this.domNode.classList.add('moving');
			this.renderShapes(); this.focus(); event.preventDefault(); return;
		}
		const shape = event.button === 1 ? undefined : hitTestDesignShapes(this.documentController.model.value.shapes, this.camera.toWorld(point));
		if (event.button === 0) {
			if (event.shiftKey && shape) {
				this.selection.toggle(shape.id);
				this.announceSelection();
				this.render(); this.focus(); event.preventDefault(); return;
			}
			if (!shape || !this.selection.ids.has(shape.id)) { this.select(shape ? [shape.id] : []); }
		}
		const shapes = shape ? this.selectedShapes : [];
		this.gesture = { pointerId: event.pointerId, start: point, shapes, preview: shapes, last: point };
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
		const path = gesture.shapes[0];
		if (gesture.handle && path.kind === 'path') {
			const world = this.camera.toWorld(point);
			const local = toDesignLocal(path, world);
			const position = {
				x: Math.max(0, Math.min(1, local.x / path.width)),
				y: Math.max(0, Math.min(1, local.y / path.height)),
			};
			const handle = gesture.handle;
			const nodes = path.nodes.map((node, index) => {
				if (index !== handle.nodeIndex) { return node; }
				return handle.point === 'anchor' ? { ...node, ...position } : { ...node, [handle.point]: position };
			});
			gesture.preview = [{ ...path, nodes }];
			this.renderShapes();
		} else if (gesture.shapes.length) {
			gesture.preview = gesture.shapes.map(shape => ({ ...shape, x: shape.x + (point.x - gesture.start.x) / this.camera.scale, y: shape.y + (point.y - gesture.start.y) / this.camera.scale }));
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
		if (commit && gesture.preview.length) { this.commands.updateShapes(gesture.preview); }
		if (!this.isDisposed) { this.render(); }
	}

	private cancelGesture(): void {
		if (this.gesture) { this.finishGesture(this.gesture.pointerId, false); }
	}

	private deleteSelected(): void {
		if (this.documentController.isBusy) { return; }
		this.cancelGesture();
		this.commands.removeShapes(this.selection.ids);
		this.focus();
	}

	private groupSelected(): void {
		if (this.documentController.isBusy) { return; }
		this.cancelGesture();
		const id = this.commands.group(this.selection.ids);
		if (id) { this.select([id]); this.render(); }
		this.focus();
	}

	private ungroupSelected(): void {
		if (this.documentController.isBusy || this.selectedShape?.kind !== 'group') { return; }
		this.cancelGesture();
		this.select(this.commands.ungroup(this.selectedShape.id));
		this.render(); this.focus();
	}

	private addPathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || this.documentController.isBusy) { return; }
		this.selection.nodeIndex = shape.nodes.length;
		this.commands.updateShape({ ...shape, nodes: [...shape.nodes, { x: 1, y: 1, incoming: { x: 0.75, y: 1 }, outgoing: { x: 1, y: 1 } }] });
	}

	private removePathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || shape.nodes.length <= 2 || this.documentController.isBusy) { return; }
		this.commands.updateShape({ ...shape, nodes: shape.nodes.filter((_, index) => index !== this.selection.nodeIndex) });
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.target !== this.domNode || this.documentController.isBusy) { return; }
		if (event.key === 'Escape') { this.cancelGesture(); this.select([]); this.render(); event.preventDefault(); return; }
		if (this.gesture) { return; }
		if (event.ctrlKey || event.metaKey) {
			if (event.key.toLowerCase() === 'a') { this.select(this.documentController.model.value.shapes.map(shape => shape.id)); this.render(); event.preventDefault(); }
			return;
		}
		const shapes = this.selectedShapes;
		const distance = event.shiftKey ? 10 : 1;
		const directions: Record<string, DesignPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
		const direction = directions[event.key];
		if (direction) {
			if (shapes.length) { this.commands.updateShapes(shapes.map(shape => ({ ...shape, x: shape.x + direction.x * distance, y: shape.y + direction.y * distance }))); }
			else { this.camera.panBy(-direction.x * KEYBOARD_PAN_DISTANCE, -direction.y * KEYBOARD_PAN_DISTANCE); this.applyTransform(); }
		} else {
			switch (event.key.toLowerCase()) {
				case 'r': this.addShape('rectangle'); break;
				case 'e': this.addShape('ellipse'); break;
				case 't': this.addShape('text'); break;
				case 'p': this.addShape('path'); break;
				case 'g': this.groupSelected(); break;
				case 'u': this.ungroupSelected(); break;
				case 'n': {
					const shapes = this.documentController.model.value.shapes;
					const next = shapes.find(shape => !this.selection.ids.has(shape.id));
					if (next) { this.selection.add(next.id); this.announceSelection(); this.render(); }
					break;
				}
				case 'delete': case 'backspace': this.deleteSelected(); break;
				case 'tab': {
					const shapes = this.documentController.model.value.shapes;
					const index = shapes.findIndex(item => item.id === this.selectedShapes.at(-1)?.id);
					const next = index + (event.shiftKey ? -1 : 1);
					if (next < 0 || next >= shapes.length) { return; }
					this.select([shapes[next].id]);
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
		this.renderShapes();
		this.viewport.style.setProperty('--ash-sessions-design-scale', `${this.camera.scale}`);
		this.updateZoomLabel();
	}

	private updateZoomLabel(): void {
		this.zoomDomNode.textContent = localize('sessions.design.zoom', '{0}% · 1 unit = 1 px · grid 12 px', Math.round(this.camera.scale * 100)) + (this.documentController.isDirty ? ' · ' + localize('sessions.design.unsaved', 'Unsaved changes') : '');
	}

	private async runFileOperation(operation: () => Promise<unknown>): Promise<void> {
		this.cancelGesture();
		await operation();
		if (!this.isDisposed) { this.focus(); }
	}

	public async saveDocument(): Promise<boolean> {
		this.cancelGesture();
		const saved = await this.documentController.saveDocument();
		if (!this.isDisposed) { this.focus(); }
		return saved;
	}
}
