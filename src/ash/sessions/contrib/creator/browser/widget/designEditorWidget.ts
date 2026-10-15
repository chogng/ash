import { describeDesignEffect } from '../designEffectLabels.js';
import { designEffects } from '../../common/model/designEffects.js';
import { designPaints } from '../../common/model/designPaint.js';
import { designNetworkRegions } from '../../common/model/designVectorNetwork.js';
import { designPathEditingContours, moveDesignPathNode } from '../../common/model/designVector.js';
import type { AssetVersion } from '../../../../../platform/assets/common/assetService.js';
import './designEditorWidget.css';
import { addDisposableListener, h, type IDimension } from '../../../../../base/browser/dom.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';
import type { DesignShape } from '../../common/model/document.js';
import { getDesignShapeEntries, hitTestDesignShapes } from '../../common/model/hitTest.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import type { DesignPoint } from '../../common/core/geometry.js';
import { DocumentCommands } from '../../common/commands/documentCommands.js';
import { DesignSelection } from '../../common/selection.js';
import type { DesignDocumentController } from '../designDocumentController.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DesignMediaPreview } from '../designMedia.js';
import { DesignView } from '../view.js';
import { CanvasViewport } from '../../../canvas/common/canvasViewport.js';
import { DesignInputController } from '../controller/designInputController.js';
import { DesignToolsWidget } from './designToolsWidget.js';
import type { DesignEditorContributionFactory, IDesignDrawingContribution, IDesignMotionContribution, IDesignPropertiesContribution, IDesignCodeContribution, IDesignPrototypeContribution } from '../designEditorBrowser.js';

const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_DISTANCE = 60;
const focusedViews = new WeakMap<Element, DesignEditorWidget>();
/** Design document editor; document coordinates never depend on its viewport. */
export class DesignEditorWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly commands: DocumentCommands;
	public readonly selection = new DesignSelection();
	private readonly viewChange = this._register(new Emitter<void>());
	public readonly onDidChangeView = this.viewChange.event;
	private readonly mediaPreview = this._register(new DesignMediaPreview());
	private readonly camera = new CanvasViewport();
	private readonly canvas: DesignView;
	private readonly properties: IDesignPropertiesContribution;
	private readonly contentDomNode: HTMLElement;
	private readonly messageDomNode: HTMLElement;
	private readonly zoomDomNode: HTMLElement;
	private contextMenuVisible = false;
	private vectorSelectionStatus: string | undefined;
	private readonly toolsWidget: DesignToolsWidget;
	private readonly text: import('../designEditorBrowser.js').IDesignTextContribution;
	private readonly drawing: IDesignDrawingContribution;
	private readonly motion: IDesignMotionContribution;
	private readonly code: IDesignCodeContribution;
	private readonly prototype: IDesignPrototypeContribution;
	private tool = DesignTool.Select;
	private mode = DesignMode.Design;
	private readonly input: DesignInputController;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		ownerDocument: Document,
		public readonly documentController: DesignDocumentController,
		createContributions: DesignEditorContributionFactory,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this.commands = new DocumentCommands(documentController.model);
		this.domNode = h(ownerDocument, 'section', { className: 'ash-sessions-design-view', attributes: { role: 'region', 'aria-label': localize('sessions.design.canvas', 'Design canvas'), tabindex: '0' } });
		focusedViews.set(this.domNode, this);
		this._register(toDisposable(() => {
			this.cancelGesture();
			focusedViews.delete(this.domNode);
			if (this.contextMenuVisible) { this.contextMenus.hideContextMenu(); }
		}));
		this.zoomDomNode = h(ownerDocument, 'span', { className: 'ash-sessions-design-zoom' });
		this.canvas = this._register(instantiationService.createInstance(DesignView, ownerDocument));
		this.canvas.setTool(this.tool);
		const stage = h(ownerDocument, 'div', { className: 'ash-sessions-design-stage' });
		this.toolsWidget = this._register(instantiationService.createInstance(DesignToolsWidget, ownerDocument, (tool: DesignTool) => commandService.executeCommand(`sessions.design.tool.${tool}`, this), (mode: DesignMode) => commandService.executeCommand(`sessions.design.mode.${mode}`, this), (action: string) => commandService.executeCommand(`sessions.design.${action}`, this)));
		const contributions = this._register(createContributions({
			ownerDocument,
			canvasDomNode: this.canvas.domNode,
			overlayDomNode: this.canvas.overlayDomNode,
			toDesignPoint: point => { const rect = this.canvas.domNode.getBoundingClientRect(); return this.camera.toWorld({ x: point.clientX - rect.left, y: point.clientY - rect.top }); },
			documentController,
			commands: this.commands,
			selection: this.selection,
			getTool: () => this.tool,
			getMode: () => this.mode,
			selectShape: id => this.selectShape(id),
			renderCanvas: () => this.renderShapes(),
			focusCanvas: () => this.focus(),
			runFileOperation: operation => this.runFileOperation(operation),
		}));
		this.text = contributions.text;
		this.drawing = contributions.drawing;
		this.properties = contributions.properties;
		this.motion = contributions.motion;
		this.code = contributions.code;
		this.prototype = contributions.prototype;
		stage.append(this.canvas.domNode, this.code.domNode, this.motion.domNode, this.toolsWidget.domNode, this.prototype.previewDomNode);

		this.contentDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-content', attributes: { 'aria-hidden': 'true' } });
		this.messageDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-message', attributes: { role: 'status', 'aria-live': 'polite' } });
		const statusDomNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-status' });
		statusDomNode.append(this.messageDomNode, this.zoomDomNode);
		this.domNode.append(stage, statusDomNode, this.contentDomNode);
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('sessionsDesignCanvasFocused', true);
		const active = scopedContext.createKey<boolean>('sessionsDesignCanvasActive', false);
		const textEditing = scopedContext.createKey<boolean>('sessionsDesignTextEditing', false);
		this._register(addDisposableListener(this.domNode, 'focusin', event => textEditing.set(!!(event.target as Element).closest('[contenteditable][data-design-text]'))));
		this._register(addDisposableListener(this.domNode, 'focusout', () => textEditing.set(false)));
		this._register(addDisposableListener(this.domNode, 'focus', () => { active.set(true); this.canvas.setFocused(this.domNode.matches(':focus-visible')); }));
		this._register(addDisposableListener(this.domNode, 'blur', () => { active.set(false); this.canvas.setFocused(false); }));
		this._register(this.documentController.model.onDidChange(kind => {
			this.cancelGesture();
			if (kind === 'replace') { this.text.finish(false); this.select([]); }
			else if (this.selection.retain(getDesignShapeEntries(this.documentController.model.value.shapes).map(entry => entry.shape))) { this.announceSelection(); }
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
			editText: id => this.text.edit(id),
			finishText: () => this.text.finish(),
		}, documentController, this.commands, this.selection, this.camera, this.drawing));
		this._register(addDisposableListener(this.domNode, 'keydown', event => this.handleKeyDown(event)));
		this._register(addDisposableListener(this.canvas.domNode, 'contextmenu', event => this.handleContextMenu(event)));
	}

	public initialize(): void {
		this.render();
		this.applyTransform();
	}

	public focus(): void { if (!this.prototype.focusPreview()) { this.domNode.focus(); } }
	public previewPrototype(): void { this.text.finish(); this.cancelGesture(); this.prototype.showPreview(); }
	public layout(dimension: IDimension): void { this.dimension = dimension; }
	public focusProperties(): void { this.properties.focus(); }
	public get propertiesDomNode(): HTMLElement { return this.properties.domNode; }
	public get hasProperties(): boolean { return this.mode === DesignMode.Design || this.mode === DesignMode.Draw; }
	public selectShape(id: string): void {
		this.selectShapes([id]);
	}
	public selectShapes(ids: readonly string[]): void {
		if (this.documentController.isBusy) return;
		this.cancelGesture();
		this.select(ids);
		this.render();
	}
	public revealShape(id: string): void {
		const entry = getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => entry.shape.id === id);
		if (!entry) { return; }
		this.selectShapes([id]);
		const height = this.canvas.domNode.clientHeight;
		this.camera.scale = Math.max(0.2, Math.min(1, (this.dimension.width - 48) / entry.world.width, (height - 100) / entry.world.height));
		this.camera.panX = this.dimension.width / 2 - (entry.world.x + entry.world.width / 2) * this.camera.scale;
		this.camera.panY = height / 2 - (entry.world.y + entry.world.height / 2) * this.camera.scale;
		this.applyTransform();
	}
	public setVisible(visible: boolean): void {
		if (!visible) { this.text.finish(); }
		this.prototype.setVisible(visible);
		if (!visible) {
			this.cancelGesture();
			this.properties.cancel();
			if (this.contextMenuVisible) this.contextMenus.hideContextMenu();
		}
		this.motion.setActive(visible && this.mode === DesignMode.Motion);
	}

	public static getFocused(element: HTMLElement): DesignEditorWidget | undefined {
		const root = element.closest('.ash-sessions-design-view');
		return root ? focusedViews.get(root) : undefined;
	}

	public getAccessibleContent(): string { return this.mode === DesignMode.Code ? this.code.getAccessibleContent() : this.contentDomNode.textContent! + '\n' + this.text.getAccessibleContent() + '\n' + this.prototype.getAccessibleContent(); }
	public undo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.undo(); }
	public redo(): void { if (this.documentController.isBusy) { return; } this.cancelGesture(); this.documentController.model.redo(); }
	public formatText(format: 'bold' | 'italic' | 'underline'): void { this.text.toggleFormat(format); }
	public selectAll(): void {
		if (this.text.editingId) { this.text.selectAll(); return; }
		if (this.selection.editingVector && this.selectedShape?.kind === 'path') { this.selection.nodeIndices.clear(); designPathEditingContours(this.selectedShape)[this.selection.contourIndex].nodes.forEach((_, index) => this.selection.nodeIndices.add(index)); this.render(); return; }
		if (this.documentController.isBusy) { return; }
		this.cancelGesture();
		this.select(this.documentController.model.value.shapes.map(shape => shape.id));
		this.render();
		this.focus();
	}

	private get selectedShape(): DesignShape | undefined { return this.selection.ids.size === 1 ? this.selectedShapes[0] : undefined; }
	private get selectedShapes(): readonly DesignShape[] { return getDesignShapeEntries(this.documentController.model.value.shapes).filter(entry => this.selection.ids.has(entry.shape.id) && !entry.ancestors.some(id => this.selection.ids.has(id))).map(entry => entry.shape); }

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
		// A direct insertion selects its result, including when the text tool was active.
		this.setTool(DesignTool.Select);
		this.select([this.commands.addShape(kind, this.camera.toWorld({ x: this.dimension.width / 2, y: this.canvas.domNode.clientHeight / 2 }), localize('sessions.design.text', 'Text'))]);
		this.render();
		this.focus();
	}

	public setTool(tool: DesignTool): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code) { return; }
		this.text.finish();
		this.cancelGesture();
		this.tool = tool; this.selection.editingGradient = false; this.selection.editingBlur = false; this.selection.paintingVector = false; this.selection.editingWidth = false;
		this.canvas.setTool(tool);
		this.render();
	}

	public setMode(mode: DesignMode): void {
		this.cancelGesture();
		this.mode = mode; this.selection.editingGradient = false; this.selection.editingBlur = false; this.selection.editingWidth = false;
		this.domNode.classList.toggle('code-mode', mode === DesignMode.Code);
		this.domNode.classList.toggle('motion-mode', mode === DesignMode.Motion);
		this.motion.setActive(mode === DesignMode.Motion);
		this.tool = mode === DesignMode.Draw ? DesignTool.Pen : DesignTool.Select;
		this.canvas.setTool(this.tool);
		this.render();
	}

	public addFrame(): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		this.select([this.commands.addFrame(this.viewportCenter())]);
		this.render();
		this.focus();
	}

	private viewportCenter(): DesignPoint { return this.camera.toWorld({ x: this.dimension.width / 2, y: this.canvas.domNode.clientHeight / 2 }); }

	public async importImage(): Promise<void> {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		const selected = getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => this.selection.ids.has(entry.shape.id));
		const center = selected?.world.kind === 'frame' ? { x: selected.world.x + selected.world.width / 2, y: selected.world.y + selected.world.height / 2 } : this.viewportCenter();
		const id = await this.documentController.importImage(center);
		if (this.isDisposed) { return; }
		if (id) { this.select([id]); this.render(); }
		this.focus();
	}

	public async adoptAssetVersion(version: AssetVersion): Promise<void> {
		this.setMode(DesignMode.Design);
		this.cancelGesture();
		const id = await this.documentController.adoptAssetVersion(version, this.viewportCenter());
		if (this.isDisposed) { return; }
		if (id) { this.select([id]); this.render(); }
		this.focus();
	}

	public duplicateSelected(): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		const ids = this.commands.duplicate(this.selection.ids);
		if (ids.length) { this.select(ids); }
		this.render(); this.focus();
	}

	public addAutoLayout(): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		const id = this.commands.addAutoLayout(this.selection.ids);
		if (id) { this.select([id]); this.render(); }
		this.focus();
	}

	public createComponent(): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		const id = this.commands.components.create(this.selection.ids);
		if (id) { this.select([id]); this.render(); }
		this.focus();
	}

	public detachInstance(): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion || !this.selectedShape) { return; }
		this.cancelGesture();
		this.commands.components.detach(this.selectedShape.id);
		this.focus();
	}

	public reorderSelected(order: 'front' | 'back' | 'forward' | 'backward'): void {
		if (this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion) { return; }
		this.cancelGesture();
		this.commands.reorder(this.selection.ids, order);
	}

	/** Layers and canvas share editing shortcuts while retaining their own navigation keys. */
	public handleLayerKeyDown(event: KeyboardEvent): boolean {
		if (event.defaultPrevented || this.documentController.isBusy || this.mode === DesignMode.Code || this.mode === DesignMode.Motion || this.input.isGesturing) { return false; }
		const vectorKey = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
		const vectorAction = event.altKey && event.shiftKey ? ({ f: 'vectorFlatten', u: 'vectorunion', s: 'vectorsubtract', i: 'vectorintersect', e: 'vectorexclude' } as Record<string, string>)[vectorKey] : (event.ctrlKey || event.metaKey) && event.altKey && vectorKey === 'o' ? 'vectorOutline' : (event.ctrlKey || event.metaKey) && vectorKey === 'e' ? (event.shiftKey ? 'vectorOutline' : 'vectorFlatten') : undefined;
		if (vectorAction) { const action = this.properties.getActions().find(action => action.id === `sessions.design.${vectorAction}`); if (action?.enabled) { void action.run(); } event.preventDefault(); event.stopPropagation(); return true; }
		if ((event.ctrlKey || event.metaKey) && event.altKey && (event.code === 'KeyK' || event.key.toLowerCase() === 'k')) { this.createComponent(); }
		else if ((event.ctrlKey || event.metaKey) && event.altKey && (event.code === 'KeyB' || event.key.toLowerCase() === 'b')) { this.detachInstance(); }
		else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { this.duplicateSelected(); }
		else if ((event.ctrlKey || event.metaKey) && (event.code === 'BracketLeft' || event.code === 'BracketRight' || event.key === '[' || event.key === ']')) {
			this.reorderSelected(event.code === 'BracketRight' || event.key === ']' ? event.shiftKey ? 'front' : 'forward' : event.shiftKey ? 'back' : 'backward');
		} else if (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'a') { this.addAutoLayout(); }
		else { return false; }
		event.preventDefault(); event.stopPropagation(); return true;
	}

	private renderShapes(): void {
		const scene = this.mode === DesignMode.Motion ? this.motion.getScene() : undefined;
		const preview = (shape: DesignShape): DesignShape => {
			const fillPreview = this.properties.preview;
			const updated = fillPreview?.id === shape.id ? fillPreview : this.input.preview.find(preview => preview.id === shape.id) ?? shape;
			if (updated.kind !== 'frame' && updated.kind !== 'group') { return updated; } const children = updated.children.map(preview); return children.every((child, index) => child === updated.children[index]) ? updated : { ...updated, children };
		};
		const shapes = (scene?.shapes ?? this.documentController.model.value.shapes).map(preview);
		const selected = getDesignShapeEntries(shapes).filter(entry => this.selection.ids.has(entry.shape.id));
		this.canvas.render({
			shapes,
			selectedShapes: selected.map(entry => entry.world),
			images: this.mediaPreview.getSources(this.documentController.model.value, version => this.documentController.readMedia(version)),
			draft: this.drawing.preview,
			selectionRect: this.input.selectionRect, activeContour: this.selection.contourIndex, selectedNodes: this.selection.nodeIndices,
			gradient: this.selection.editingGradient ? { paintId: this.selection.paintId, stopId: this.selection.gradientStopId } : undefined,
			blur: this.selection.editingBlur ? { effectId: this.selection.effectId, handle: this.selection.blurHandle } : undefined,
			showWidthHandles: this.selection.editingVector && this.selection.editingWidth && !selected.some(entry => this.commands.components.isInstanceChild(entry.shape.id)), selectedWidthPoints: this.selection.widthPointIds,
			showPathHandles: !this.selection.editingWidth && this.selection.editingVector && this.mode !== DesignMode.Motion && !selected.some(entry => this.commands.components.isInstanceChild(entry.shape.id)),
			scale: this.camera.scale,
			opacity: scene?.opacity,
		});
		const vectorStatus = this.selection.editingVector && this.selectedShape?.kind === 'path' ? `${this.selectedShape.id}:${this.selection.contourIndex}:${[...this.selection.nodeIndices].join(',')}:${this.selection.paintingVector}:${this.selection.editingWidth}:${[...this.selection.widthPointIds].join(',')}` : undefined;
		if (vectorStatus !== this.vectorSelectionStatus && vectorStatus) { this.messageDomNode.textContent = this.selection.editingWidth ? localize('sessions.design.widthSelection', '{0} width points selected. Drag side handles to change width, drag centers to move, or use the width fields. Delete removes width points; Escape exits vector editing.', this.selection.widthPointIds.size) : this.selection.paintingVector ? localize('sessions.design.networkPaintStatus', 'Paint regions enabled. Click a closed region to toggle its fill; Shift+B returns to node selection.') : localize('sessions.design.vectorSelection', '{0} nodes selected. Escape exits vector editing.', this.selection.nodeIndices.size); }
		this.vectorSelectionStatus = vectorStatus;
		this.text.update();
		if (this.text.editingId) { this.canvas.domNode.querySelector<SVGElement>(`[data-shape-id="${this.text.editingId}"]`)?.setAttribute('visibility', 'hidden'); }
		const showProperties = this.mode === DesignMode.Design || this.mode === DesignMode.Draw;
		// A properties preview changes the canvas, not the committed anchors addressed by the other editing controls.
		this.properties.update(showProperties && selected.length === 1 ? this.properties.preview ? this.selectedShape : selected[0].shape : undefined, showProperties);
		this.prototype.update(this.camera.scale, this.mode === DesignMode.Design);
		this.viewChange.fire();
	}

	private handleContextMenu(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.cancelGesture();
		const bounds = this.canvas.domNode.getBoundingClientRect();
		const point = this.camera.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
		const shapes = this.mode === DesignMode.Motion ? this.motion.getScene().shapes : this.documentController.model.value.shapes;
		const shape = hitTestDesignShapes(shapes, point);
		// Keep a multi-selection when opening its menu, including on empty canvas space.
		if (!this.documentController.isBusy && shape && !this.selection.ids.has(shape.id)) {
			this.select([shape.id]);
			this.render();
		}
		this.showContextMenu({ x: event.clientX, y: event.clientY, targetWindow: this.domNode.ownerDocument.defaultView! });
	}

	public showContextMenu(anchor: ContextMenuAnchor, restoreFocus: () => void = () => this.focus()): void {
		this.cancelGesture();
		this.focus();
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => this.getContextMenuActions(),
			getMenuClassName: () => 'ash-design-menu',
			onHide: () => { this.contextMenuVisible = false; restoreFocus(); },
		});
		this.contextMenuVisible = true;
	}

	private getContextMenuActions(): readonly IAction[] {
		const shapes = this.documentController.model.value.shapes;
		const selected = this.selectedShape;
		return [
			this.action('undo', localize('sessions.design.undo', 'Undo'), () => this.undo(), !this.documentController.isBusy && this.documentController.model.canUndo),
			this.action('redo', localize('sessions.design.redo', 'Redo'), () => this.redo(), !this.documentController.isBusy && this.documentController.model.canRedo),
			new Separator(),
			this.action('delete', localize('sessions.design.delete', 'Delete'), () => this.deleteSelected(), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('selectAll', localize('sessions.design.selectAll', 'Select all'), () => this.selectAll(), !this.documentController.isBusy && shapes.length > 0),
			this.action('duplicate', localize('sessions.design.duplicate', 'Duplicate'), () => this.duplicateSelected(), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('bringToFront', localize('sessions.design.bringToFront', 'Bring to front'), () => this.reorderSelected('front'), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('sendToBack', localize('sessions.design.sendToBack', 'Send to back'), () => this.reorderSelected('back'), !this.documentController.isBusy && this.selection.ids.size > 0),
			this.action('addAutoLayout', localize('sessions.design.addAutoLayout', 'Add auto layout'), () => this.addAutoLayout(), !this.documentController.isBusy && this.commands.canAddAutoLayout(this.selection.ids)),
			this.action('group', localize('sessions.design.group', 'Group'), () => this.groupSelected(), !this.documentController.isBusy && this.commands.canGroup(this.selection.ids)),
			this.action('createComponent', localize('sessions.design.createComponent', 'Create component'), () => this.createComponent(), !this.documentController.isBusy && this.commands.components.canCreate(this.selection.ids)),
			this.action('detachInstance', localize('sessions.design.detachInstance', 'Detach instance'), () => this.detachInstance(), !this.documentController.isBusy && selected?.kind === 'frame' && !!selected.instance && !this.commands.components.isInstanceChild(selected.id)),
			this.action('ungroup', localize('sessions.design.ungroup', 'Ungroup'), () => this.ungroupSelected(), !this.documentController.isBusy && selected?.kind === 'group' && !selected.motion),
			...this.properties.getActions(),
			new Separator(),
			this.action('addFrame', localize('sessions.design.addFrame', 'Add frame (F)'), () => this.addFrame(), !this.documentController.isBusy && this.mode !== DesignMode.Code && this.mode !== DesignMode.Motion),
			this.action('importImage', localize('sessions.design.importImage', 'Import image'), () => this.importImage(), !this.documentController.isBusy && this.mode !== DesignMode.Code && this.mode !== DesignMode.Motion),
			this.action('export', localize('sessions.design.export', 'Export SVG'), () => this.runFileOperation(() => this.documentController.exportDocument()), !this.documentController.isBusy && shapes.length > 0),
			this.action('open', localize('sessions.design.open', 'Open design'), () => this.runFileOperation(() => this.documentController.openDocument()), !this.documentController.isBusy),
		];
	}

	private render(): void {
		this.renderShapes();
		const shapes = this.documentController.model.value.shapes;
		const selected = this.selectedShape;
		this.toolsWidget.update(this.tool, this.mode, this.documentController.isBusy);
		this.motion.update(selected, this.documentController.isBusy);
		this.code.update(this.documentController.model.value, this.mode === DesignMode.Code, this.documentController.isBusy);

		const describe = (shape: DesignShape, index: number): string => {
			const labels = {
				rectangle: localize('sessions.design.rectangle', 'Rectangle'),
				ellipse: localize('sessions.design.ellipse', 'Ellipse'),
				text: localize('sessions.design.text', 'Text'),
				path: localize('sessions.design.path', 'Bézier path'),
				group: localize('sessions.design.group', 'Group'),
				frame: localize('sessions.design.frame', 'Frame'),
				image: localize('sessions.design.image', 'Image'),
			};
			let content = localize('sessions.design.shapeDescription', '{0}. {1}: X {2}, Y {3}, width {4}, height {5}, rotation {6} degrees, fill {7}', index + 1, shape.name || labels[shape.kind], shape.x, shape.y, shape.width, shape.height, shape.rotation, shape.fill);
			if (this.selection.ids.has(shape.id)) { content += ' · ' + localize('sessions.design.selected', 'Selected'); }
			if (shape.kind === 'frame' && shape.component) {
				content += '\n' + (shape.component.kind === 'set' ? localize('sessions.design.componentSet', 'Component set') : localize('sessions.design.mainComponent', 'Main component'));
				if (shape.component.kind === 'main' && shape.component.variant) { content += ': ' + Object.entries(shape.component.variant).map(([key, value]) => `${key}=${value}`).join(', '); }
			}
			if (shape.kind === 'frame' && shape.instance) {
				const main = this.commands.components.getMain(shape.id);
				content += '\n' + (main ? localize('sessions.design.instanceOf', 'Instance of {0}', main.name || localize('sessions.design.component', 'Component')) : localize('sessions.design.missingMain', 'Main component is missing'));
			}
			if (shape.visible === false) { content += '\n' + localize('sessions.design.hidden', 'Hidden'); }
			if (Object.keys(shape.bindings ?? {}).length || Object.keys(shape.styleBindings ?? {}).length) { content += '\n' + localize('sessions.design.resourceReferenceCount', '{0} variable bindings; {1} style references.', Object.keys(shape.bindings ?? {}).length, Object.keys(shape.styleBindings ?? {}).length); }
			if (shape.overrides?.length) { content += '\n' + localize('sessions.design.overrideCount', '{0} property overrides.', shape.overrides.length); }
			if (shape.kind === 'frame' && shape.autoLayout) { content += '\n' + localize('sessions.design.layoutDescription', '{0} auto layout; gap {1}; padding top {2}, right {3}, bottom {4}, left {5}.', shape.autoLayout.direction === 'grid' ? localize('sessions.design.gridLayout', 'Grid') : shape.autoLayout.direction === 'horizontal' ? localize('sessions.design.horizontal', 'Horizontal') : localize('sessions.design.vertical', 'Vertical'), shape.autoLayout.gap, shape.autoLayout.padding.top, shape.autoLayout.padding.right, shape.autoLayout.padding.bottom, shape.autoLayout.padding.left); }
			if (shape.kind === 'frame' && shape.autoLayout?.wrap) { content += '\n' + localize('sessions.design.wrapDescription', 'Wrap enabled; line gap {0}.', shape.autoLayout.crossGap ?? shape.autoLayout.gap); }
			if (shape.kind === 'frame' && shape.autoLayout?.direction === 'grid' && shape.autoLayout.grid) {
				const grid = shape.autoLayout.grid;
				content += '\n' + localize('sessions.design.gridDescription', '{0} columns; rows: {1}; row gap {2}; positioning: {3}.', grid.columns.length, grid.autoRows ? localize('sessions.design.automatic', 'Auto') : grid.rows.length, shape.autoLayout.crossGap ?? shape.autoLayout.gap, grid.positioning === 'auto' ? localize('sessions.design.automatic', 'Auto') : localize('sessions.design.manual', 'Manual'));
			}
			if (shape.gridCell) { content += '\n' + localize('sessions.design.cellDescription', 'Column span {0}; row span {1}.', shape.gridCell.columnSpan ?? 1, shape.gridCell.rowSpan ?? 1); }
			if (shape.sizeLimits) { content += '\n' + localize('sessions.design.limitsDescription', 'Width limits: {0} to {1}; height limits: {2} to {3}.', shape.sizeLimits.minWidth ?? localize('sessions.design.noLimit', 'None'), shape.sizeLimits.maxWidth ?? localize('sessions.design.noLimit', 'None'), shape.sizeLimits.minHeight ?? localize('sessions.design.noLimit', 'None'), shape.sizeLimits.maxHeight ?? localize('sessions.design.noLimit', 'None')); }
			if (shape.kind === 'text') { content += `\n${shape.text}`; }
			if (shape.kind === 'path' && shape.network) { content += '\n' + localize('sessions.design.networkDescription', '{0} shared nodes; {1} segments; {2} filled regions.', shape.network.vertices.length, shape.network.edges.length, designNetworkRegions(shape.network).filter(region => region.filled).length); }
			else if (shape.kind === 'path') { content += '\n' + localize('sessions.design.pathDescription', '{0} nodes; closed: {1}', shape.network?.vertices.length ?? shape.nodes.length, shape.closed ? localize('sessions.design.yes', 'Yes') : localize('sessions.design.no', 'No')); }
			if (shape.kind === 'image') { content += '\n' + this.documentController.model.value.assets.find(asset => asset.id === shape.assetId)!.name; }
			if (shape.kind === 'group' || shape.kind === 'frame') { content += '\n' + shape.children.map(describe).join('\n'); }
			if (designEffects(shape).length) { content += '\n' + localize('sessions.design.effectsReview', 'Effects: {0}', designEffects(shape).map(describeDesignEffect).join('; ')); }
			if (shape.motion) { content += '\n' + localize('sessions.design.motionDescription', '{0} keyframes, duration {1} ms, loop: {2}', shape.motion.keyframes.length, shape.motion.duration, shape.motion.loop ? localize('sessions.design.yes', 'Yes') : localize('sessions.design.no', 'No')); }
			return content;
		};
		this.contentDomNode.textContent = shapes.length === 0 ? localize('sessions.design.empty', 'The design document is empty.') : shapes.map(describe).join('\n');
		const resources = this.commands.resources.value;
		if (resources.collections.length || resources.styles.length || resources.libraries.length) { this.contentDomNode.textContent += '\n' + localize('sessions.design.resourceDescription', 'Variables: {0}. Styles: {1}. Libraries: {2}.', resources.variables.map(variable => variable.name).join(', '), resources.styles.map(style => style.name).join(', '), resources.libraries.map(library => library.name).join(', ')); }
		this.domNode.classList.toggle('dirty', this.documentController.isDirty);
		this.updateZoomLabel();
	}

	private cancelGesture(): void { this.input.cancelGesture(); }

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


	private handleBlurKeyDown(event: KeyboardEvent): boolean {
		if (!this.selection.editingBlur) { return false; }
		if (event.key === 'Escape') {
			this.cancelGesture();
			this.selection.editingBlur = false;
			this.render();
			event.preventDefault();
			return true;
		}
		const shape = this.selectedShape;
		if (!shape || this.commands.components.isInstanceChild(shape.id)) { return false; }
		const effects = designEffects(shape), effect = effects.find(effect => effect.id === this.selection.effectId);
		if (!effect || !('progressive' in effect) || !effect.progressive || effect.visible === false) { return false; }
		if (event.key === 'Enter') {
			this.selection.blurHandle = this.selection.blurHandle === 'start' ? 'end' : 'start';
			this.render();
		} else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
			if (!this.input.isGesturing) {
				const handle = this.selection.blurHandle, point = effect.progressive[handle];
				const amount = event.shiftKey ? 10 : 1;
				const x = point.x + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0) / shape.width;
				const y = point.y + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0) / shape.height;
				this.commands.updateShape({
					...shape, effects: effects.map(value => value.id === effect.id ? {
						...effect, progressive: { ...effect.progressive!, [handle]: { x, y } }
					} : value)
				});
			}
		} else { return false; }
		this.messageDomNode.textContent = this.selection.blurHandle === 'start'
			? localize('sessions.design.blurStartSelected', 'Blur start selected. Arrow keys move it; Shift moves ten pixels. Enter selects the end. Escape exits blur editing.')
			: localize('sessions.design.blurEndSelected', 'Blur end selected. Arrow keys move it; Shift moves ten pixels. Enter selects the start. Escape exits blur editing.');
		event.preventDefault();
		return true;
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.target === this.domNode) { this.canvas.setFocused(true); }
		if (event.defaultPrevented || event.target !== this.domNode) { return; }
		if (event.key === 'Escape' && this.properties.preview) { this.properties.cancel(); this.render(); event.preventDefault(); return; }
		if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
			event.preventDefault();
			this.showContextMenu(this.canvas.domNode);
			return;
		}
		if (this.documentController.isBusy || this.mode === DesignMode.Code) { return; }
		if (this.handleBlurKeyDown(event)) { return; }
		if (event.key === 'Enter' && this.properties.preview) { const apply = this.properties.getActions().find(action => action.id === 'sessions.design.offsetApply' && action.enabled); if (apply) { void apply.run(); event.preventDefault(); return; } }
		if (this.selection.editingWidth && this.selectedShape?.kind === 'path' && ['Delete', 'Backspace'].includes(event.key) && !this.commands.components.isInstanceChild(this.selectedShape.id)) {
			const path = this.selectedShape; this.commands.vector.update({ ...path, widthPoints: path.widthPoints?.filter(point => !this.selection.widthPointIds.has(point.id)) }); this.selection.widthPointIds.clear(); this.render(); event.preventDefault(); return;
		}
		if ((event.key === 'Enter' || event.key === 'F2') && this.selectedShapes.length === 1 && this.selectedShapes[0].kind === 'text') { event.preventDefault(); this.text.edit(this.selectedShapes[0].id); return; }
		if (event.shiftKey && event.code === 'KeyB' && this.selection.editingVector && this.selectedShape?.kind === 'path' && this.selectedShape.network) { this.selection.paintingVector = !this.selection.paintingVector; this.render(); event.preventDefault(); return; }
		if (this.selection.editingGradient && this.selectedShape && !this.commands.components.isInstanceChild(this.selectedShape.id)) {
			const shape = this.selectedShape, paints = designPaints(shape), paint = paints.find(paint => paint.id === this.selection.paintId) ?? paints[0];
			if (paint && paint.type !== 'solid') {
				const stop = paint.stops.find(stop => stop.id === this.selection.gradientStopId) ?? paint.stops[0];
				if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { const delta = (event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1) * (event.shiftKey ? .1 : .01); this.commands.updateShape({ ...shape, fills: paints.map(value => value.id === paint.id ? { ...paint, stops: paint.stops.map(value => value.id === stop.id ? { ...value, position: Math.max(0, Math.min(1, value.position + delta)) } : value).sort((a, b) => a.position - b.position) } : value) }); event.preventDefault(); return; }
				if (event.key === 'Delete' || event.key === 'Backspace') { if (paint.stops.length > 2) { this.commands.updateShape({ ...shape, fills: paints.map(value => value.id === paint.id ? { ...paint, stops: paint.stops.filter(value => value.id !== stop.id) } : value) }); this.selection.gradientStopId = undefined; } event.preventDefault(); return; }
			}
		}
		if (event.key === 'Escape' && this.selection.editingGradient) { this.selection.editingGradient = false; this.render(); event.preventDefault(); return; }
		if (event.key === 'Escape' && this.selection.editingVector) { this.selection.editingVector = false; this.selection.paintingVector = false; this.selection.editingWidth = false; this.announceSelection(); this.render(); event.preventDefault(); return; }
		if (event.key === 'Enter' && this.selectedShape?.kind === 'path' && !this.commands.components.isInstanceChild(this.selectedShape.id)) { this.selection.editingVector = !this.selection.editingVector; this.announceSelection(); this.render(); event.preventDefault(); return; }
		if (event.key === 'Escape') { this.cancelGesture(); this.select([]); this.render(); event.preventDefault(); return; }
		if (this.input.isGesturing) { return; }

		if (this.handleLayerKeyDown(event)) { return; }
		if (event.ctrlKey || event.metaKey) {
			if (event.key.toLowerCase() === 'a') { this.selectAll(); event.preventDefault(); }
			return;
		}
		const shapes = this.selectedShapes;
		const distance = event.shiftKey ? 10 : 1;
		const directions: Record<string, DesignPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
		const direction = directions[event.key];
		if (this.selection.editingVector && this.selectedShape?.kind === 'path' && !this.commands.components.isInstanceChild(this.selectedShape.id) && (direction || ['Delete', 'Backspace'].includes(event.key))) {
			const path = this.selectedShape;
			if (direction) {
				const placed = getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => entry.shape.id === path.id)!.world;
				const angle = -placed.rotation * Math.PI / 180;
				this.commands.vector.editContour(path, this.selection.contourIndex, contour => ({ ...contour, nodes: contour.nodes.map((node, index) => this.selection.nodeIndices.has(index) ? moveDesignPathNode(node, 'anchor', { x: node.x + (direction.x * Math.cos(angle) - direction.y * Math.sin(angle)) * distance / placed.width, y: node.y + (direction.x * Math.sin(angle) + direction.y * Math.cos(angle)) * distance / placed.height }, path.width, path.height) : node) }));
			} else if (event.shiftKey) { this.commands.vector.healNodes(path, this.selection.contourIndex, this.selection.nodeIndices); this.selection.selectNode(0, 0); this.render(); }
			else { this.commands.vector.removeNodes(path, this.selection.contourIndex, this.selection.nodeIndices); }
			event.preventDefault(); return;
		}
		if (direction) {
			if (shapes.length) {
				const entries = getDesignShapeEntries(this.documentController.model.value.shapes);
				this.commands.updateShapes(shapes.map(shape => {
					const entry = entries.find(entry => entry.shape.id === shape.id)!;
					const radians = -(entry.world.rotation - shape.rotation) * Math.PI / 180;
					const step = distance / entry.parentScale;
					return { ...shape, x: shape.x + (direction.x * Math.cos(radians) - direction.y * Math.sin(radians)) * step, y: shape.y + (direction.x * Math.sin(radians) + direction.y * Math.cos(radians)) * step };
				}));
			}
			else { this.camera.panBy(-direction.x * KEYBOARD_PAN_DISTANCE, -direction.y * KEYBOARD_PAN_DISTANCE); this.applyTransform(); }
		} else {
			switch (event.key.toLowerCase()) {
				case 'f': this.addFrame(); break;
				case 'i': void this.importImage(); break;
				case 'v': this.setTool(DesignTool.Select); break;
				case 'h': this.setTool(DesignTool.Hand); break;
				case 'r': this.addShape('rectangle'); break;
				case 'e': this.addShape('ellipse'); break;
				case 't': this.setTool(DesignTool.Text); break;
				case 'p': this.setTool(DesignTool.Pen); break;
				case 'g': this.groupSelected(); break;
				case 'u': this.ungroupSelected(); break;
				case 'n': {
					const shapes = getDesignShapeEntries(this.documentController.model.value.shapes).map(entry => entry.shape);
					const next = shapes.find(shape => !this.selection.ids.has(shape.id));
					if (next) { this.selection.add(next.id); this.announceSelection(); this.render(); }
					break;
				}
				case 'delete': case 'backspace': this.deleteSelected(); break;
				case 'tab': {
					const shapes = getDesignShapeEntries(this.documentController.model.value.shapes).map(entry => entry.shape);
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
