import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { DesignDocumentController } from './designDocumentController.js';
import type { DesignEditorWidget } from './widget/designEditorWidget.js';
import { CreatorMode } from '../common/creator.js';

export const DESIGN_LAYERS_CONTAINER_ID = 'workbench.sessions.sidebar.designLayers';
export const DESIGN_PROPERTIES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.designProperties';

/** Each mode retains its document; panels borrow the active canvas's selection and components. */
export interface IDesignEditorService {
	readonly document: DesignDocumentController;
	readonly activeEditor: IObservable<DesignEditorWidget | undefined>;
	getDocument(mode: CreatorMode): DesignDocumentController;
	setActiveEditor(editor: DesignEditorWidget | undefined): void;
}

export const IDesignEditorService = createServiceIdentifier<IDesignEditorService>('designEditorService');

export class DesignEditorService extends Disposable implements IDesignEditorService {
	private readonly documents = new Map<CreatorMode, DesignDocumentController>();
	public get document(): DesignDocumentController { return this.getDocument(CreatorMode.Design); }
	private readonly active = observableValue<DesignEditorWidget | undefined>(this, undefined);
	public readonly activeEditor: IObservable<DesignEditorWidget | undefined> = this.active;
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService, @IWorkingCopyService private readonly workingCopies: IWorkingCopyService, @ILifecycleService lifecycle: ILifecycleService) {
		super();
		this._register(lifecycle.onBeforeShutdown(event => event.veto(this.confirmDiscard(), 'unsavedCreator')));
	}
	public getDocument(mode: CreatorMode): DesignDocumentController {
		let document = this.documents.get(mode);
		if (!document) {
			document = this._register(this.instantiation.createInstance(DesignDocumentController, mode));
			this._register(this.workingCopies.register(document));
			this.documents.set(mode, document);
		}
		return document;
	}
	private async confirmDiscard(): Promise<boolean> {
		for (const document of this.documents.values()) {
			if (await document.confirmDiscard()) { return true; }
		}
		return false;
	}
	public setActiveEditor(editor: DesignEditorWidget | undefined): void { this.active.set(editor); }
	protected override disposeCore(): void { this.active.set(undefined); super.disposeCore(); }
}
