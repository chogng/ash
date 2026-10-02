import { addDisposableListener, getWindow, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import { type DesignDocumentController, DESIGN_EDITOR_RESOURCE } from './designDocumentController.js';
import { IDesignEditorService } from './designEditorService.js';
import { DesignEditorWidget } from './widget/designEditorWidget.js';
import { createDesignEditorContributions } from '../design.main.js';
import type { DesignEditorContributionContext } from './designEditorBrowser.js';

/** EditorPart owns Design panes and their editing state; the window Design service owns the shared document. */
export class DesignEditorPage extends Disposable implements IEditorPane {
	public static readonly ID = 'sessions.design.editor';
	public readonly id = DesignEditorPage.ID;
	public readonly workingCopy: DesignDocumentController;
	public domNode!: HTMLElement;
	private editor!: DesignEditorWidget;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IDesignEditorService private readonly designEditors: IDesignEditorService,
	) {
		super();
		this.workingCopy = designEditors.document;
	}

	public create(parent: HTMLElement): void {
		this.editor = this._register(this.instantiationService.createInstance(DesignEditorWidget, parent.ownerDocument, this.workingCopy, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, this.instantiationService)));
		this.domNode = this.editor.domNode;
		parent.append(this.domNode);
		this.editor.initialize();
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.designEditors.setActiveEditor(this.editor)));
		// Browser unload cannot await EditorPart's asynchronous save confirmation.
		this._register(addDisposableListener(getWindow(this.domNode), 'beforeunload', (event: BeforeUnloadEvent) => {
			if (this.workingCopy.isDirty && !this.lifecycle.willShutdown) { event.preventDefault(); event.returnValue = ''; }
		}));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (input.resource.toString() !== DESIGN_EDITOR_RESOURCE.toString()) throw new TypeError('Unsupported Design editor input');
	}
	public clearInput(): void { this.setVisible(EditorPaneVisibility.Hidden); }
	public setVisible(visibility: EditorPaneVisibility): void {
		const visible = visibility === EditorPaneVisibility.Visible;
		this.editor.setVisible(visible);
		if (visible) this.designEditors.setActiveEditor(this.editor);
		else if (this.designEditors.activeEditor.get() === this.editor) this.designEditors.setActiveEditor(undefined);
	}
	protected override disposeCore(): void {
		if (this.editor) this.clearInput();
		super.disposeCore();
		this.domNode?.remove();
	}
	public focus(): void { this.editor.focus(); }
	public layout(dimension: IDimension): void { this.editor.layout(dimension); }
	public async save(): Promise<void> { await this.editor.saveDocument(); }
	public async saveAs(resource: URI): Promise<void> { await this.workingCopy.saveAs(resource, new AbortController().signal); }
}
