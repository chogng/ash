import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { DesignDocumentController } from './designDocumentController.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import type { DesignEditorWidget } from './widget/designEditorWidget.js';

export const DESIGN_LAYERS_CONTAINER_ID = 'workbench.sessions.sidebar.designLayers';
export const DESIGN_PROPERTIES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.designProperties';

/** One window document is shared by panes; panels borrow the active pane's selection and components. */
export interface IDesignEditorService {
	readonly document: DesignDocumentController;
	readonly input: EditorInput;
	readonly activeEditor: IObservable<DesignEditorWidget | undefined>;
	setActiveEditor(editor: DesignEditorWidget | undefined): void;
}

export const IDesignEditorService = createServiceIdentifier<IDesignEditorService>('designEditorService');

export class DesignEditorService extends Disposable implements IDesignEditorService {
	public readonly document: DesignDocumentController;
	public readonly input: EditorInput;
	private readonly active = observableValue<DesignEditorWidget | undefined>(this, undefined);
	public readonly activeEditor: IObservable<DesignEditorWidget | undefined> = this.active;
	constructor(@IInstantiationService instantiation: IInstantiationService, @IWorkingCopyService workingCopies: IWorkingCopyService, @ILifecycleService lifecycle: ILifecycleService) {
		super();
		// Every split of the canvas resource shares its document; selection and viewport remain pane-local.
		this.document = this._register(instantiation.createInstance(DesignDocumentController));
		const document = this.document;
		this.input = { resource: document.resource, get label() { return document.name; }, onDidChangeLabel: document.onDidChangeLabel, showBreadcrumbs: false };
		this._register(workingCopies.register(document));
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.document.isBusy, 'designFileOperation')));
	}
	public setActiveEditor(editor: DesignEditorWidget | undefined): void { this.active.set(editor); }
	protected override disposeCore(): void { this.active.set(undefined); super.disposeCore(); }
}
