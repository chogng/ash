import { addDisposableListener, getWindow, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';

import type { DesignDocumentController } from './designDocumentController.js';
import { IDesignEditorService } from './designEditorService.js';
import { DesignEditorWidget } from './widget/designEditorWidget.js';
import { createDesignEditorContributions } from '../design.main.js';
import type { DesignEditorContributionContext } from './designEditorBrowser.js';
import { CreatorMode } from '../common/creator.js';

/** The page retains canvas state; the window editor service owns one document per Creator mode. */
export class DesignEditorPage extends Disposable {
	public readonly workingCopy: DesignDocumentController;
	public domNode!: HTMLElement;
	public editor!: DesignEditorWidget;

	constructor(
		mode: CreatorMode,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IDesignEditorService private readonly designEditors: IDesignEditorService,
	) {
		super();
		this.workingCopy = designEditors.getDocument(mode);
	}

	public create(parent: HTMLElement): void {
		this.editor = this._register(this.instantiationService.createInstance(DesignEditorWidget, parent.ownerDocument, this.workingCopy, (context: DesignEditorContributionContext) => createDesignEditorContributions(context, this.instantiationService)));
		this.domNode = this.editor.domNode;
		parent.append(this.domNode);
		this.editor.initialize();
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.designEditors.setActiveEditor(this.editor)));
		// Browser unload cannot await the lifecycle's asynchronous save confirmation.
		this._register(addDisposableListener(getWindow(this.domNode), 'beforeunload', (event: BeforeUnloadEvent) => {
			if (this.workingCopy.isDirty && !this.lifecycle.willShutdown) { event.preventDefault(); event.returnValue = ''; }
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
	public async save(): Promise<void> { await this.editor.saveDocument(); }
	public async saveAs(resource: URI): Promise<void> { await this.workingCopy.saveAs(resource, new AbortController().signal); }
}
