import './artifactWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
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
import { registerArtifactWorkspace, type ArtifactWorkspaceContribution, type IArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import type { ArtifactEditorWidget } from './widget/artifactEditorWidget.js';
import type { DesignDocumentController } from './designDocumentController.js';
import { DESIGN_PROPERTIES_CONTAINER_ID, IDesignEditorService } from './designEditorService.js';

export interface ArtifactDesignExample {
	readonly title: string;
	readonly editorMode?: DesignMode;
	createShapes(): readonly DesignShape[];
}

const artifactWorkspaces = new Map<ArtifactWorkspaceId, (instantiation: IInstantiationService, container: HTMLElement, example?: ArtifactDesignExample, document?: DesignDocumentController) => ArtifactWorkspace>();

export function registerArtifactWorkspaceMode(
	mode: Omit<ArtifactWorkspaceContribution, 'mount'>,
	create: (instantiation: IInstantiationService, document: Document) => ArtifactWorkspace,
): void {
	const mount = (instantiation: IInstantiationService, container: HTMLElement, example?: ArtifactDesignExample, document?: DesignDocumentController) => {
		const workspace = create(instantiation, container.ownerDocument);
		try {
			workspace.create(container, example, document);
			return workspace;
		} catch (error) {
			workspace.dispose();
			throw error;
		}
	};
	artifactWorkspaces.set(mode.id, mount);
	registerArtifactWorkspace({ ...mode, mount: (instantiation, container) => mount(instantiation, container) });
}

export function mountArtifactWorkspace(instantiation: IInstantiationService, container: HTMLElement, mode: ArtifactWorkspaceId, example?: ArtifactDesignExample, document?: DesignDocumentController): ArtifactWorkspace {
	return artifactWorkspaces.get(mode)!(instantiation, container, example, document);
}

const ActiveArtifactWorkspace = new RawContextKey<ArtifactWorkspaceId | undefined>('sessions.artifacts.activeCanvasWorkspace', undefined);
const ArtifactWorkspaceCanEdit = new RawContextKey<boolean>('sessions.artifacts.canvasWorkspaceCanEdit', false);
const ArtifactWorkspaceHasManagedDocument = new RawContextKey<boolean>('sessions.artifacts.canvasWorkspaceHasManagedDocument', false);

interface ArtifactWorkspaceAction<T> {
	readonly id: string;
	readonly title: ILocalizedString;
	readonly precondition?: ContextKeyExpression;
	readonly when?: ContextKeyExpression;
	run(workspace: T): unknown;
}

/** Canvas modes borrow document lifecycle and geometry; their contribution owns all mode-specific controls. */
export class ArtifactWorkspace extends Disposable implements IArtifactWorkspace {
	public domNode!: HTMLElement;
	public readonly detailsContainerId: string | undefined = DESIGN_PROPERTIES_CONTAINER_ID;
	protected editorHost!: DesignEditorHost;
	protected contentDomNode!: HTMLElement;
	private toolbarContext: IContextKeyService | undefined;
	private activeWorkspace: IContextKey<ArtifactWorkspaceId | undefined> | undefined;
	private initialFrame: string | undefined;
	protected get editor(): ArtifactEditorWidget { return this.editorHost.editor; }
	protected get document(): DesignDocumentController { return this.editorHost.workingCopy; }
	public get title(): string { return this.document.name; }
	public get onDidChangeTitle() { return Event.any(this.document.onDidChangeLabel, this.document.onDidChangeContent); }
	public get rename(): ((title: string) => Promise<void>) | undefined {
		return this.document.artifactKind && !this.document.isBusy ? title => this.document.rename(title) : undefined;
	}
	public get delete(): (() => Promise<void>) | undefined {
		return this.document.artifactKind && !this.document.isBusy ? () => this.designEditors.deleteArtifactDocument(this.document) : undefined;
	}
	public getCodeAttachment(): { readonly name: string; readonly content: string; } {
		return { name: `${this.title}.ash-design.json`, content: this.document.backup() };
	}
	public exportActions: readonly Action[] = [];
	protected get commands(): DocumentCommands { return new DocumentCommands(this.document.model); }

	constructor(
		protected readonly ownerDocument: Document,
		public readonly mode: ArtifactWorkspaceId,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IDesignEditorService private readonly designEditors: IDesignEditorService,
	) { super(); }

	protected static registerWorkspaceActions<T extends ArtifactWorkspace>(
		this: new (...args: never[]) => T,
		mode: ArtifactWorkspaceId,
		actions: readonly ArtifactWorkspaceAction<T>[],
	): void {
		ArtifactWorkspace.registerActions(this, `sessions.creator.${mode}`, 'navigation', ActiveArtifactWorkspace.isEqualTo(mode), actions);
	}

	public static registerFileActions(): void {
		const when = ContextKeyExpr.and(
			ContextKeyExpr.has(ActiveArtifactWorkspace.key),
			ContextKeyExpr.notEquals(ActiveArtifactWorkspace.key, ArtifactWorkspaceId.Design),
		);
		ArtifactWorkspace.registerActions(ArtifactWorkspace, 'sessions.creator.canvas', 'file', when, [
			{ id: 'open', title: localize2('sessions.creator.open', 'Open document'), when: ArtifactWorkspaceHasManagedDocument.isEqualTo(false), run: workspace => workspace.document.openDocument() },
			{ id: 'save', title: localize2('sessions.creator.save', 'Save document'), when: ArtifactWorkspaceHasManagedDocument.isEqualTo(false), run: workspace => workspace.editor.saveDocument() },
		]);
	}

	private static registerActions<T extends ArtifactWorkspace>(
		workspaceType: new (...args: never[]) => T,
		idPrefix: string,
		group: string,
		when: ContextKeyExpression | undefined,
		actions: readonly ArtifactWorkspaceAction<T>[],
	): void {
		actions.forEach((action, order) => {
			const precondition = ContextKeyExpr.and(ArtifactWorkspaceCanEdit.isEqualTo(true), action.precondition);
			const visible = ContextKeyExpr.and(when, action.when);
			const canRun = ContextKeyExpr.and(visible, precondition);
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `${idPrefix}.${action.id}`,
						title: action.title,
						precondition,
						menu: { id: Menus.ArtifactToolbar, when: visible, group, order },
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

	public create(container: HTMLElement, example?: ArtifactDesignExample, document?: DesignDocumentController): void {
		this.domNode = h(this.ownerDocument, 'section', { className: 'ash-creator-workspace', attributes: { 'data-creator-mode': this.mode } });
		this.contentDomNode = h(this.ownerDocument, 'div', { className: 'ash-creator-workspace-content' });
		this.domNode.append(this.contentDomNode);
		container.append(this.domNode);
		const scope = this._register(this.contextKeys.createScoped(this.domNode));
		this.toolbarContext = scope;
		this.activeWorkspace = ActiveArtifactWorkspace.bindTo(scope);
		const canEdit = ArtifactWorkspaceCanEdit.bindTo(scope);
		const scopedInstantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, scope])));
		this.editorHost = this._register(scopedInstantiation.createInstance(DesignEditorHost, this.mode));
		this.editorHost.create(this.contentDomNode, example, document);
		const exportSvg = this._register(new Action('sessions.creator.canvas.exportSvg', localize2('sessions.design.export', 'Export SVG').value,
			'', true, () => this.document.exportDocument()));
		this.exportActions = this.mode === ArtifactWorkspaceId.Design || this.document.artifactKind !== undefined
			? [this._register(new Action('sessions.creator.canvas.exportCopy', this.document.artifactKind === 'slides'
				? localize2('sessions.creator.slides.exportCopy', 'Export editable copy').value
				: localize2('sessions.design.saveCopy', 'Save a copy').value, '', true, () => this.document.saveCopy())), exportSvg]
			: [exportSvg];
		ArtifactWorkspaceHasManagedDocument.bindTo(scope).set(this.document.artifactKind !== undefined);
		this.editor.setWorkspaceToolbarContext(this);
		this.createModeContent();
		if (example || document) { this.initialFrame = this.document.model.value.shapes[0]?.id; }
		const editorMode = document?.artifactKind === 'motion' ? DesignMode.Motion : example?.editorMode;
		if (editorMode) { this.editor.setMode(editorMode); }
		const updateModeContext = this.bindToolbarContext?.(scope);
		const updateContext = () => scope.bufferChangeEvents(() => {
			canEdit.set(!this.document.isBusy);
			for (const action of this.exportActions) action.enabled = !this.document.isBusy;
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
