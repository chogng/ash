import './creatorCanvasWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { localize } from '../../../../nls.js';
import { EditorPaneVisibility } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { DesignEditorPage } from './designEditorPage.js';
import { DocumentCommands } from '../common/commands/documentCommands.js';
import type { DesignShape } from '../common/model/document.js';
import { DesignMode } from '../common/config/editorConfiguration.js';
import type { CreatorMode } from '../common/creator.js';
import type { ICreatorWorkspace } from './creatorWorkspace.js';
import type { DesignEditorWidget } from './widget/designEditorWidget.js';
import type { DesignDocumentController } from './designDocumentController.js';

/** Canvas modes borrow document lifecycle and geometry; their contribution owns all mode-specific controls. */
export abstract class CreatorCanvasWorkspace extends Disposable implements ICreatorWorkspace {
	public domNode!: HTMLElement;
	public readonly usesCanvasPanels: boolean = true;
	protected page!: DesignEditorPage;
	protected contentDomNode!: HTMLElement;
	protected actionsDomNode!: HTMLElement;
	protected toolbar!: WorkbenchToolBar;
	protected get editor(): DesignEditorWidget { return this.page.editor; }
	protected get document(): DesignDocumentController { return this.page.workingCopy; }
	protected get commands(): DocumentCommands { return new DocumentCommands(this.document.model); }

	constructor(
		protected readonly ownerDocument: Document,
		public readonly mode: CreatorMode,
		@IInstantiationService protected readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) { super(); }

	public create(container: HTMLElement): void {
		this.domNode = h(this.ownerDocument, 'section', { className: 'ash-creator-workspace', attributes: { 'data-creator-mode': this.mode } });
		this.actionsDomNode = h(this.ownerDocument, 'div', { className: 'ash-creator-workspace-actions' });
		this.contentDomNode = h(this.ownerDocument, 'div', { className: 'ash-creator-workspace-content' });
		this.domNode.append(this.actionsDomNode, this.contentDomNode);
		container.append(this.domNode);
		this.page = this._register(this.instantiation.createInstance(DesignEditorPage, this.mode));
		this.page.create(this.contentDomNode);
		this.toolbar = this._register(new WorkbenchToolBar(this.actionsDomNode, this.contextMenus, { ariaLabel: localize('sessions.creator.workspaceActions', 'Workspace actions') }));
		this.createModeContent();
		this._register(this.document.model.onDidChange(() => this.updateActions()));
		this._register(this.document.onDidChange(() => this.updateActions()));
		this._register(this.editor.onDidChangeView(() => this.updateActions()));
		this.updateActions();
	}

	protected updateActions(): void {
		this.toolbar.setActions(this.getModeActions(), [
			this.action('open', localize('sessions.creator.open', 'Open document'), () => this.document.openDocument()),
			this.action('save', localize('sessions.creator.save', 'Save document'), () => this.editor.saveDocument()),
			this.action('exportSvg', localize('sessions.design.export', 'Export SVG'), () => this.document.exportDocument()),
		]);
	}

	protected createModeContent(): void { }
	protected abstract getModeActions(): readonly IAction[];
	protected action(id: string, label: string, run: () => unknown, enabled = true): IAction {
		return { id: `sessions.creator.${this.mode}.${id}`, label, tooltip: label, run, enabled: enabled && !this.document.isBusy };
	}
	protected addFrame(width: number, height: number): string {
		this.editor.setMode(DesignMode.Design);
		const frames = this.document.model.value.shapes;
		const x = Math.max(0, ...frames.map(shape => shape.x + shape.width + 40));
		const frame: DesignShape = { id: generateUuid(), kind: 'frame', x, y: 0, width, height, rotation: 0, fill: '#ffffff', clip: true, children: [] };
		this.commands.insertShape(frame);
		this.editor.revealShape(frame.id);
		return frame.id;
	}
	public setVisible(visible: boolean): void { this.page.setVisible(visible ? EditorPaneVisibility.Visible : EditorPaneVisibility.Hidden); }
	public layout(dimension: IDimension): void {
		this.domNode.classList.toggle('narrow', dimension.width < 600);
		this.page.layout({ width: dimension.width, height: Math.max(0, dimension.height - this.actionsDomNode.offsetHeight) });
	}
	public focus(): void { this.page.focus(); }
	public getAccessibleContent(): string { return this.editor.getAccessibleContent(); }
}
