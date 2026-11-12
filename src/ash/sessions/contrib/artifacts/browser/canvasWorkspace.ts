import './canvasWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, RawContextKey, type ContextKeyExpression, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { localize2, type ILocalizedString } from '../../../../nls.js';
import { Menus } from '../../../browser/menus.js';

import { DesignEditorHost } from './designEditorHost.js';
import { DocumentCommands } from '../common/commands/documentCommands.js';
import { flattenDesignShapes, type DesignShape } from '../common/model/designDocument.js';
import { DesignMode } from '../common/config/designEditorConfiguration.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import type { IArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import type { CanvasEditorWidget } from './widget/canvasEditorWidget.js';
import type { DesignDocumentController } from './designDocumentController.js';
import type { CanvasArtifactExample } from './artifactExamples.js';

const ActiveCanvasWorkspace = new RawContextKey<ArtifactWorkspaceId | undefined>('sessions.artifacts.activeCanvasWorkspace', undefined);
const CanvasWorkspaceCanEdit = new RawContextKey<boolean>('sessions.artifacts.canvasWorkspaceCanEdit', false);
const CanvasWorkspaceHasManagedDocument = new RawContextKey<boolean>('sessions.artifacts.canvasWorkspaceHasManagedDocument', false);

interface CanvasWorkspaceAction<T> {
	readonly id: string;
	readonly title: ILocalizedString;
	readonly precondition?: ContextKeyExpression;
	readonly when?: ContextKeyExpression;
	run(workspace: T): unknown;
}

/** Canvas modes borrow document lifecycle and geometry; their contribution owns all mode-specific controls. */
export class CanvasWorkspace extends Disposable implements IArtifactWorkspace {
	public domNode!: HTMLElement;
	public readonly usesCanvasPanels: boolean = true;
	protected editorHost!: DesignEditorHost;
	protected contentDomNode!: HTMLElement;
	private toolbarContext: IContextKeyService | undefined;
	private activeWorkspace: IContextKey<ArtifactWorkspaceId | undefined> | undefined;
	private initialFrame: string | undefined;
	protected get editor(): CanvasEditorWidget { return this.editorHost.editor; }
	protected get document(): DesignDocumentController { return this.editorHost.workingCopy; }
	protected get commands(): DocumentCommands { return new DocumentCommands(this.document.model); }

	constructor(
		protected readonly ownerDocument: Document,
		public readonly mode: ArtifactWorkspaceId,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) { super(); }

	protected static registerWorkspaceActions<T extends CanvasWorkspace>(
		this: new (...args: never[]) => T,
		mode: ArtifactWorkspaceId,
		actions: readonly CanvasWorkspaceAction<T>[],
	): void {
		CanvasWorkspace.registerActions(this, `sessions.creator.${mode}`, 'navigation', ActiveCanvasWorkspace.isEqualTo(mode), actions);
	}

	public static registerFileActions(): void {
		const when = ContextKeyExpr.and(
			ContextKeyExpr.has(ActiveCanvasWorkspace.key),
			ContextKeyExpr.notEquals(ActiveCanvasWorkspace.key, ArtifactWorkspaceId.Design),
		);
		CanvasWorkspace.registerActions(CanvasWorkspace, 'sessions.creator.canvas', 'file', when, [
			{ id: 'open', title: localize2('sessions.creator.open', 'Open document'), when: CanvasWorkspaceHasManagedDocument.isEqualTo(false), run: workspace => workspace.document.openDocument() },
			{ id: 'save', title: localize2('sessions.creator.save', 'Save document'), when: CanvasWorkspaceHasManagedDocument.isEqualTo(false), run: workspace => workspace.editor.saveDocument() },
			{ id: 'exportCopy', title: localize2('sessions.creator.slides.exportCopy', 'Export editable copy'), when: CanvasWorkspaceHasManagedDocument.isEqualTo(true), run: workspace => workspace.document.saveCopy() },
			{ id: 'exportSvg', title: localize2('sessions.design.export', 'Export SVG'), run: workspace => workspace.document.exportDocument() },
		]);
	}

	private static registerActions<T extends CanvasWorkspace>(
		workspaceType: new (...args: never[]) => T,
		idPrefix: string,
		group: string,
		when: ContextKeyExpression | undefined,
		actions: readonly CanvasWorkspaceAction<T>[],
	): void {
		actions.forEach((action, order) => {
			const precondition = ContextKeyExpr.and(CanvasWorkspaceCanEdit.isEqualTo(true), action.precondition);
			const visible = ContextKeyExpr.and(when, action.when);
			const canRun = ContextKeyExpr.and(visible, precondition);
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `${idPrefix}.${action.id}`,
						title: action.title,
						precondition,
						menu: { id: Menus.ArtifactCanvasToolbar, when: visible, group, order },
					});
				}
				override run(_accessor: ServicesAccessor, workspace: unknown): unknown {
					// Menu actions forward their originating workspace, including from the overflow menu.
					if (workspace instanceof workspaceType && !workspace.isDisposed && workspace.toolbarContext?.contextMatchesRules(canRun)) {
						return action.run(workspace);
					}
				}
			});
		});
	}

	public create(container: HTMLElement, example?: CanvasArtifactExample, document?: DesignDocumentController): void {
		this.domNode = h(this.ownerDocument, 'section', { className: 'ash-creator-workspace', attributes: { 'data-creator-mode': this.mode } });
		this.contentDomNode = h(this.ownerDocument, 'div', { className: 'ash-creator-workspace-content' });
		this.domNode.append(this.contentDomNode);
		container.append(this.domNode);
		const scope = this._register(this.contextKeys.createScoped(this.domNode));
		this.toolbarContext = scope;
		this.activeWorkspace = ActiveCanvasWorkspace.bindTo(scope);
		const canEdit = CanvasWorkspaceCanEdit.bindTo(scope);
		const scopedInstantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, scope])));
		this.editorHost = this._register(scopedInstantiation.createInstance(DesignEditorHost, this.mode));
		this.editorHost.create(this.contentDomNode, example, document);
		CanvasWorkspaceHasManagedDocument.bindTo(scope).set(this.document.artifactKind !== undefined);
		this.editor.setWorkspaceToolbarContext(this);
		this.createModeContent();
		const title = h(this.ownerDocument, 'h1', { className: 'ash-canvas-editor-title' }, this.document.name);
		this.editor.prependToolbarControl(title);
		this._register(this.document.onDidChangeLabel(() => { title.textContent = this.document.name; }));
		if (example || document) { this.initialFrame = this.document.model.value.shapes[0]?.id; }
		const editorMode = document?.artifactKind === 'motion' ? DesignMode.Motion : example?.editorMode;
		if (editorMode) { this.editor.setMode(editorMode); }
		const updateModeContext = this.bindToolbarContext?.(scope);
		const updateContext = () => scope.bufferChangeEvents(() => {
			canEdit.set(!this.document.isBusy);
			updateModeContext?.();
		});
		this._register(this.document.onDidChange(updateContext));
		if (updateModeContext) {
			this._register(this.document.model.onDidChange(updateContext));
			this._register(this.editor.onDidChangeView(updateContext));
		}
		updateContext();
	}

	protected createPageNavigation(): HTMLElement {
		const navigation = h(this.ownerDocument, 'div', { className: 'ash-creator-workspace-navigation' });
		this.editor.prependToolbarControl(navigation);
		return navigation;
	}

	protected createModeContent(): void { }
	protected bindToolbarContext?(contextKeys: IContextKeyService): () => void;
	protected addFrame(width: number, height: number): string {
		this.editor.setMode(DesignMode.Design);
		const frames = this.document.model.value.shapes;
		const x = Math.max(0, ...frames.map(shape => shape.x + shape.width + 40));
		const frame: DesignShape = { id: generateUuid(), kind: 'frame', x, y: 0, width, height, rotation: 0, fill: '#ffffff', clip: true, children: [] };
		this.commands.insertShape(frame);
		this.editor.revealShape(frame.id);
		return frame.id;
	}
	public setVisible(visible: boolean): void {
		this.activeWorkspace?.set(visible ? this.mode : undefined);
		this.editorHost.setVisible(visible);
	}
	public layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		this.editorHost.layout(dimension);
	}
	public revealInitialContent(): void {
		const { clientWidth, clientHeight } = this.contentDomNode;
		if (this.initialFrame && clientWidth > 0 && clientHeight > 0) {
			this.editorHost.layout({ width: clientWidth, height: clientHeight });
			this.editor.revealShape(this.initialFrame);
			this.initialFrame = undefined;
			const animatedShape = flattenDesignShapes(this.document.model.value.shapes).find(shape => shape.motion);
			if (animatedShape) { this.editor.selectShape(animatedShape.id); }
		}
	}
	public focus(): void { this.editorHost.focus(); }
	public getAccessibleContent(): string { return this.editor.getAccessibleContent(); }
}
