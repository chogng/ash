import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CanvasInputController, CanvasPointerAction, type CanvasInputParticipant, type CanvasPointerInput } from '../../../canvas/browser/canvasInputController.js';
import type { CanvasViewport } from '../../../canvas/common/canvasViewport.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import type { DocumentCommands } from '../../common/commands/documentCommands.js';
import { toDesignLocal, type DesignPoint } from '../../common/core/geometry.js';
import type { DesignShape } from '../../common/model/document.js';
import { getDesignShapeEntries, hitTestDesignShapes } from '../../common/model/hitTest.js';
import type { DesignSelection } from '../../common/selection.js';
import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';
import type { DesignDrawingParticipant } from '../designEditorBrowser.js';

type PathHandle = { readonly nodeIndex: number; readonly point: 'anchor' | 'incoming' | 'outgoing' };
interface ShapeGesture {
	readonly start: DesignPoint;
	readonly shapes: readonly DesignShape[];
	readonly handle?: PathHandle;
	preview: readonly DesignShape[];
}

interface InputHost {
	readonly viewport: HTMLElement;
	readonly domNode: HTMLElement;
	getTool(): DesignTool;
	getMode(): DesignMode;
	getShapesForHitTesting(): readonly DesignShape[];
	render(): void;
	applyTransform(): void;
	selectionChanged(): void;
}

/** Design owns hit targets and edits; shared canvas input owns coordinates and capture. */
export class DesignInputController extends Disposable implements CanvasInputParticipant {
	private gesture: ShapeGesture | undefined;
	private isDrawing = false;
	private readonly input: CanvasInputController;

	constructor(private readonly host: InputHost, private readonly documentController: DesignDocumentController, private readonly commands: DocumentCommands, private readonly selection: DesignSelection, private readonly camera: CanvasViewport, private readonly drawing: DesignDrawingParticipant) {
		super();
		this.input = this._register(new CanvasInputController({ domNode: host.viewport, focus: () => host.domNode.focus(), applyTransform: () => host.applyTransform() }, camera, this));
		this._register(addDisposableListener(host.viewport, 'dblclick', event => { if (this.drawing.complete()) { event.preventDefault(); } }));
		this._register(addDisposableListener(host.domNode, 'keydown', (event: KeyboardEvent) => {
			if (event.target !== host.domNode || !this.drawing.preview) { return; }
			if (event.key === 'Escape') { this.cancelGesture(); event.preventDefault(); }
			else if (event.key === 'Enter' && this.drawing.complete()) { event.preventDefault(); }
		}));
	}

	public get isGesturing(): boolean { return this.input.isGesturing; }
	public get preview(): readonly DesignShape[] { return this.gesture?.preview ?? []; }
	private get selectedShapes(): readonly DesignShape[] { return getDesignShapeEntries(this.documentController.model.value.shapes).filter(entry => this.selection.ids.has(entry.shape.id) && !entry.ancestors.some(id => this.selection.ids.has(id))).map(entry => entry.shape); }
	private get selectedShape(): DesignShape | undefined { return this.selection.ids.size === 1 ? this.selectedShapes[0] : undefined; }
	private select(ids: readonly string[]): void { this.selection.set(ids); this.host.selectionChanged(); }
	public canNavigate(): boolean { return !this.drawing.preview; }

	public begin(input: CanvasPointerInput): CanvasPointerAction {
		if (this.host.getMode() === DesignMode.Code || this.documentController.isBusy) { return CanvasPointerAction.None; }
		const { event, point, world } = input;
		if (event.button === 0 && this.drawing.begin(world)) {
			this.isDrawing = this.drawing.preview !== undefined;
			return this.isDrawing ? CanvasPointerAction.Edit : CanvasPointerAction.Handled;
		}
		const target = event.target as Element;
		const path = this.selectedShape;
		if (this.host.getMode() !== DesignMode.Motion && this.host.getTool() === DesignTool.Select && event.button === 0 && target.classList.contains('ash-sessions-design-path-handle') && path?.kind === 'path') {
			const handle: PathHandle = { nodeIndex: Number(target.getAttribute('data-path-node')), point: target.getAttribute('data-path-point') as PathHandle['point'] };
			this.selection.nodeIndex = handle.nodeIndex;
			this.gesture = { start: point, shapes: [path], preview: [path], handle };
			this.host.render();
			return CanvasPointerAction.Move;
		}
		const shape = event.button === 1 || this.host.getTool() === DesignTool.Hand ? undefined : hitTestDesignShapes(this.host.getShapesForHitTesting(), world);
		if (this.host.getMode() === DesignMode.Motion && shape) {
			this.select([shape.id]);
			this.host.render();
			return CanvasPointerAction.Handled;
		}
		if (event.button === 0 && this.host.getTool() !== DesignTool.Hand) {
			if (event.shiftKey && shape) {
				this.selection.toggle(shape.id);
				this.host.selectionChanged();
				this.host.render();
				return CanvasPointerAction.Handled;
			}
			if (!shape || !this.selection.ids.has(shape.id)) { this.select(shape ? [shape.id] : []); }
		}
		if (shape) {
			const shapes = this.selectedShapes;
			this.gesture = { start: point, shapes, preview: shapes };
		}
		this.host.render();
		return shape ? CanvasPointerAction.Move : CanvasPointerAction.Pan;
	}

	public update(input: CanvasPointerInput): void {
		if (this.isDrawing) { this.drawing.update(input.world); return; }
		const gesture = this.gesture!;
		const path = gesture.shapes[0];
		if (gesture.handle && path.kind === 'path') {
			const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => entry.shape.id === path.id)!.world;
			const local = toDesignLocal(placed, input.world);
			const position = { x: Math.max(0, Math.min(1, local.x / path.width)), y: Math.max(0, Math.min(1, local.y / path.height)) };
			const handle = gesture.handle;
			const nodes = path.nodes.map((node, index) => {
				if (index !== handle.nodeIndex) { return node; }
				return handle.point === 'anchor' ? { ...node, ...position } : { ...node, [handle.point]: position };
			});
			gesture.preview = [{ ...path, nodes }];
		} else {
			const entries = getDesignShapeEntries(this.documentController.model.value.shapes);
			gesture.preview = gesture.shapes.map(shape => {
				const parent = entries.find(entry => entry.shape.id === shape.id)!.parent;
				const angle = (parent?.rotation ?? 0) * Math.PI / 180;
				const dx = (input.point.x - gesture.start.x) / this.camera.scale;
				const dy = (input.point.y - gesture.start.y) / this.camera.scale;
				return { ...shape, x: shape.x + dx * Math.cos(angle) + dy * Math.sin(angle), y: shape.y - dx * Math.sin(angle) + dy * Math.cos(angle) };
			});
		}
		this.host.render();
	}

	public end(input: CanvasPointerInput): void {
		if (this.isDrawing) {
			this.drawing.update(input.world);
			this.isDrawing = false;
			this.drawing.end();
			return;
		}
		const gesture = this.gesture!;
		this.gesture = undefined;
		this.commands.updateShapes(gesture.preview);
		this.host.render();
	}

	public cancel(): void {
		this.isDrawing = false;
		const hadGesture = this.gesture !== undefined;
		this.gesture = undefined;
		this.drawing.cancel();
		if (hadGesture && !this.isDisposed) { this.host.render(); }
	}

	public cancelGesture(): void { this.input.cancel(); }
}
