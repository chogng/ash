import { addDisposableListener, getWindow, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';

import type { DesignDocumentController } from './designDocumentController.js';
import { IDesignEditorService } from './designEditorService.js';
import { ArtifactEditorWidget } from './widget/artifactEditorWidget.js';
import { createDesignEditorContributionFactory } from './designEditorContributions.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';

/** The host retains canvas state while the window editor service owns one document per workspace. */
export class DesignEditorHost extends Disposable {
	private document!: DesignDocumentController;
	public get workingCopy(): DesignDocumentController { return this.document; }
	public domNode!: HTMLElement;
	public editor!: ArtifactEditorWidget;

	constructor(
		private readonly mode: ArtifactWorkspaceId,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IDesignEditorService private readonly designEditors: IDesignEditorService,
	) { super(); }

	public create(parent: HTMLElement, document?: DesignDocumentController): void {
		this.document = document ?? this.designEditors.getDocument(this.mode);
		this.editor = this._register(this.instantiationService.createInstance(ArtifactEditorWidget, parent.ownerDocument, this.workingCopy, createDesignEditorContributionFactory(this.instantiationService)));
		this.domNode = this.editor.domNode;
		parent.append(this.domNode);
		this.editor.initialize();
		const updateRestoring = () => {
			this.domNode.inert = this.workingCopy.isRestoring;
			this.domNode.setAttribute('aria-busy', String(this.workingCopy.isRestoring));
		};
		this._register(this.workingCopy.onDidChange(updateRestoring));
		updateRestoring();
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.designEditors.setActiveEditor(this.editor)));
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
	public async save(): Promise<void> { await this.workingCopy.save(new AbortController().signal); }
	public async saveAs(resource: URI): Promise<void> { await this.workingCopy.saveAs(resource, new AbortController().signal); }
}
