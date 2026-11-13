import { addDisposableListener, getWindow, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';

import type { ArtifactCanvasDocumentController } from './artifactCanvasDocumentController.js';
import { IArtifactCanvasEditorService } from './artifactCanvasEditorService.js';
import { ArtifactEditorWidget } from './widget/artifactEditorWidget.js';
import { createArtifactCanvasEditorContributionFactory } from './artifactCanvasEditorContributions.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';

/** The host retains canvas state while the window editor service owns one document per workspace. */
export class ArtifactCanvasEditorHost extends Disposable {
	private document!: ArtifactCanvasDocumentController;
	public get workingCopy(): ArtifactCanvasDocumentController { return this.document; }
	public domNode!: HTMLElement;
	public editor!: ArtifactEditorWidget;

	constructor(
		private readonly mode: ArtifactWorkspaceId,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IArtifactCanvasEditorService private readonly artifactCanvasEditors: IArtifactCanvasEditorService,
	) { super(); }

	public create(parent: HTMLElement, document?: ArtifactCanvasDocumentController): void {
		this.document = document ?? this.artifactCanvasEditors.getDocument(this.mode);
		this.editor = this._register(this.instantiationService.createInstance(ArtifactEditorWidget, parent.ownerDocument, this.workingCopy, createArtifactCanvasEditorContributionFactory(this.instantiationService)));
		this.domNode = this.editor.domNode;
		parent.append(this.domNode);
		this.editor.initialize();
		const updateRestoring = () => {
			this.domNode.inert = this.workingCopy.isRestoring;
			this.domNode.setAttribute('aria-busy', String(this.workingCopy.isRestoring));
		};
		this._register(this.workingCopy.onDidChange(updateRestoring));
		updateRestoring();
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.artifactCanvasEditors.setActiveEditor(this.editor)));
		this._register(addDisposableListener(getWindow(this.domNode), 'beforeunload', (event: BeforeUnloadEvent) => {
			if (!this.workingCopy.automaticallySaves && this.workingCopy.isDirty && !this.lifecycle.willShutdown) { event.preventDefault(); event.returnValue = ''; }
		}));
		this._register(addDisposableListener(getWindow(this.domNode), 'pagehide', () => {
			if (this.workingCopy.automaticallySaves) { void this.workingCopy.flushAutoSave(); }
		}));
	}

	public clearInput(): void { this.setVisible(false); }
	public setVisible(visibility: boolean): void {
		const visible = visibility;
		this.editor.setVisible(visible);
		if (visible) this.artifactCanvasEditors.setActiveEditor(this.editor);
		else if (this.artifactCanvasEditors.activeEditor.get() === this.editor) this.artifactCanvasEditors.setActiveEditor(undefined);
	}
	protected override disposeCore(): void {
		if (this.editor) this.clearInput();
		super.disposeCore();
		this.domNode?.remove();
	}
	public focus(): void { this.editor.focus(); }
	public layout(dimension: IDimension): void { this.editor.layout(dimension); }
	public async save(): Promise<void> { await this.workingCopy.save(new AbortController().signal); }
	public async saveAs(resource: URI): Promise<void> { await this.workingCopy.saveAs(resource, new AbortController().signal); }
}
