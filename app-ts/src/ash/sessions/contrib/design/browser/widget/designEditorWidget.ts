import './designEditorWidget.css';
import { addDisposableListener, h, type IDimension } from '../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';
import type { DesignShape } from '../../common/model/document.js';
import type { DesignPoint } from '../../common/core/geometry.js';
import { DocumentCommands } from '../../common/commands/documentCommands.js';
import { DesignSelection } from '../../common/selection.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { DesignView } from '../view.js';
import { DesignViewport } from '../../common/viewport.js';
import { DesignInputController } from '../controller/designInputController.js';
import { DesignToolsWidget } from './designToolsWidget.js';
import type { DesignEditorContributionFactory, IDesignDrawingContribution, IDesignMotionContribution, IDesignPropertiesContribution, IDesignCodeContribution } from '../designEditorBrowser.js';

const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_DISTANCE = 60;
const focusedViews = new WeakMap<Element, DesignEditorWidget>();
/** Design document editor; document coordinates never depend on its viewport. */
export class DesignEditorWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly commands: DocumentCommands;
	private readonly selection = new DesignSelection();
	private readonly camera = new DesignViewport();
	private readonly canvas: DesignView;
	private readonly properties: IDesignPropertiesContribution;
	private readonly contentDomNode: HTMLElement;
	private readonly messageDomNode: HTMLElement;
	private readonly zoomDomNode: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private readonly toolsWidget: DesignToolsWidget;
	private readonly drawing: IDesignDrawingContribution;
	private readonly motion: IDesignMotionContribution;
	private readonly code: IDesignCodeContribution;
	private tool = DesignTool.Select;
	private mode = DesignMode.Design;
	private readonly input: DesignInputController;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		container: HTMLElement,
		private readonly documentController: DesignDocumentController,
		createContributions: DesignEditorContributionFactory,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
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
		this.canvas = this._register(instantiationService.createInstance(DesignView, this.domNode));
		this.canvas.setTool(this.tool);
		const stage = h(ownerDocument, 'div', { className: 'ash-sessions-design-stage' });
		this.toolsWidget = this._register(new DesignToolsWidget(this.domNode, tool => this.setTool(tool), mode => this.setMode(mode)));
		const contributions = this._register(createContributions({
			container: this.domNode,
			documentController,
			commands: this.commands,
			selection: this.selection,
			getTool: () => this.tool,
			getMode: () => this.mode,
			selectShape: id => { this.select([id]); this.render(); },
			renderCanvas: () => this.renderShapes(),
			runFileOperation: operation => this.runFileOperation(operation),
		}));
		this.drawing = contributions.drawing;
		this.properties = contributions.properties;
		this.motion = contributions.motion;
		this.code = contributions.code;
		stage.append(this.canvas.domNode, this.code.domNode, this.motion.domNode, this.toolsWidget.domNode);

		this.contentDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-content', attributes: { 'aria-hidden': 'true' } });
		this.messageDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		this.domNode.append(toolbarDomNode, stage, this.properties.domNode, this.messageDomNode, this.contentDomNode);
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('sessionsDesignCanvasFocused', true);
		const active = scopedContext.createKey<boolean>('sessionsDesignCanvasActive', false);
		this._register(addDisposableListener(this.domNode, 'focus', () => { active.set(true); this.canvas.setFocused(this.domNode.matches(':focus-visible')); }));
		this._register(addDisposableListener(this.domNode, 'blur', () => { active.set(false); this.canvas.setFocused(false); }));
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
		this._register(this.drawing.onDidChange(() => this.renderShapes()));
		this._register(this.motion.onDidChangeTime(() => this.renderShapes()));
		this.input = this._register(new DesignInputController({
			viewport: this.canvas.domNode,
			domNode: this.domNode,
			getTool: () => this.tool,
			getMode: () => this.mode,
			getShapesForHitTesting: () => this.mode === DesignMode.Motion ? this.motion.getScene().shapes : this.documentController.model.value.shapes,
			render: () => this.render(),
			applyTransform: () => this.applyTransform(),
			selectionChanged: () => this.announceSelection(),
		}, documentController, this.commands, this.selection, this.camera, this.drawing));
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

	public getAccessibleContent(): string { return this.mode === DesignMode.Code ? this.code.getAccessibleContent() : this.contentDomNode.textContent!; }
	public undo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.undo(); }
	public redo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.redo(); }
	public selectAll(): void {
		if (this.documentController.isBusy) { return; }
		this.cancelGesture();
		this.select(this.documentController.model.value.shapes.map(shape => shape.id));
		this.render();
		this.focus();
	}

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
		this.select([this.commands.addShape(kind, this.camera.toWorld({ x: this.dimension.width / 2, y: this.canvas.domNode.clientHeight / 2 }), localize('sessions.design.text', 'Text'))]);
		this.render();
		this.focus();
	}

	private setTool(tool: DesignTool): void {
		this.cancelGesture();
		this.tool = tool;
		this.canvas.setTool(tool);
		this.render();
	}

	private setMode(mode: DesignMode): void {
		this.cancelGesture();
		this.mode = mode;
		this.domNode.classList.toggle('code-mode', mode === DesignMode.Code);
		this.domNode.classList.toggle('motion-mode', mode === DesignMode.Motion);
		this.motion.setActive(mode === DesignMode.Motion);
		this.setTool(mode === DesignMode.Draw ? DesignTool.Pen : DesignTool.Select);
		this.render();
	}

	private renderShapes(): void {
		const scene = this.mode === DesignMode.Motion ? this.motion.getScene() : undefined;
		const shapes = (scene?.shapes ?? this.documentController.model.value.shapes).map(shape => this.input.preview.find(preview => preview.id === shape.id) ?? shape);
		const selected = shapes.filter(shape => this.selection.ids.has(shape.id));
		this.canvas.render({
			shapes,
			selectedShapes: selected,
			draft: this.drawing.preview,
			showPathHandles: this.mode !== DesignMode.Motion,
			scale: this.camera.scale,
			opacity: scene?.opacity,
		});
		const showProperties = this.mode === DesignMode.Design || this.mode === DesignMode.Draw;
		this.properties.update(showProperties && selected.length === 1 ? selected[0] : undefined, showProperties);
	}

	private render(): void {
		this.renderShapes();
		const shapes = this.documentController.model.value.shapes;
		const selected = this.selectedShape;
		this.toolsWidget.update(this.tool, this.mode, this.documentController.isBusy);
		this.motion.update(selected, this.documentController.isBusy);
		this.code.update(this.documentController.model.value, this.mode === DesignMode.Code, this.documentController.isBusy);
		this.toolbar.setActions([
			this.action('undo', localize('sessions.design.undo', 'Undo'), () => this.undo(), !this.documentController.isBusy && this.documentController.model.canUndo),
			this.action('redo', localize('sessions.design.redo', 'Redo'), () => this.redo(), !this.documentController.isBusy && this.documentController.model.canRedo),
			this.action('delete', localize('sessions.design.delete', 'Delete'), () => this.deleteSelected(), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('selectAll', localize('sessions.design.selectAll', 'Select all'), () => this.selectAll(), !this.documentController.isBusy && shapes.length > 0),
			this.action('group', localize('sessions.design.group', 'Group'), () => this.groupSelected(), !this.documentController.isBusy && this.selection.ids.size > 1),
			this.action('ungroup', localize('sessions.design.ungroup', 'Ungroup'), () => this.ungroupSelected(), !this.documentController.isBusy && selected?.kind === 'group' && !selected.motion),
			...this.properties.getActions(),
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
			if (shape.motion) { content += '\n' + localize('sessions.design.motionDescription', '{0} keyframes, duration {1} ms, loop: {2}', shape.motion.keyframes.length, shape.motion.duration, shape.motion.loop ? localize('sessions.design.yes', 'Yes') : localize('sessions.design.no', 'No')); }
			return content;
		};
		this.contentDomNode.textContent = shapes.length === 0 ? localize('sessions.design.empty', 'The design document is empty.') : shapes.map(describe).join('\n');
		this.domNode.classList.toggle('dirty', this.documentController.isDirty);
		this.updateZoomLabel();
	}

	private cancelGesture(): void { this.input.cancel(); }

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
		if (this.documentController.isBusy || this.selectedShape?.kind !== 'group' || this.selectedShape.motion) { return; }
		this.cancelGesture();
		this.select(this.commands.ungroup(this.selectedShape.id));
		this.render(); this.focus();
	}


	private handleKeyDown(event: KeyboardEvent): void {
		if (event.target === this.domNode) { this.canvas.setFocused(true); }
		if (event.defaultPrevented || event.target !== this.domNode || this.documentController.isBusy || this.mode === DesignMode.Code) { return; }
		if (event.key === 'Escape') { this.cancelGesture(); this.select([]); this.render(); event.preventDefault(); return; }
		if (this.input.isGesturing) { return; }
		if (event.ctrlKey || event.metaKey) {
			if (event.key.toLowerCase() === 'a') { this.selectAll(); event.preventDefault(); }
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
				case 'v': this.setTool(DesignTool.Select); break;
				case 'h': this.setTool(DesignTool.Hand); break;
				case 'z': this.setTool(DesignTool.Zoom); break;
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
		this.camera.zoomAt({ x: this.dimension.width / 2, y: this.canvas.domNode.clientHeight / 2 }, factor);
		this.applyTransform();
	}

	private applyTransform(): void {
		this.canvas.applyTransform(this.camera);
		this.renderShapes();
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
