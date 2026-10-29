import { ActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../../base/common/event.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { ModelPickerWidget } from './modelPickerWidget.js';

export interface IModelPickerDelegate {
	readonly onDidChangePresentation: Event<void>;
	getModels(): readonly ModelCatalogEntry[];
	getSelectedModel(): ModelRef | undefined;
	getSelectedReasoningEffort(): ModelReasoningEffort | undefined;
	isAutomaticModel(): boolean;
	getModelsError(): string | undefined;
	selectModel(model: ModelRef): Promise<void>;
	selectAutomaticModel(): Promise<void>;
	selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void>;
	openSettings(): Promise<void>;
}

/** Adapts the combined picker to the input toolbar's focus contract. */
export class ModelPickerActionItem extends ActionViewItem {
	private readonly pickerWidget: ModelPickerWidget;

	constructor(action: IAction, delegate: IModelPickerDelegate, @IInstantiationService instantiationService: IInstantiationService) {
		super(action);
		this.pickerWidget = this._register(instantiationService.createInstance(ModelPickerWidget, delegate));
	}

	public override render(container: HTMLElement): void {
		container.classList.add('ash-chat-input-model-selector');
		this.pickerWidget.render(container);
		this.pickerWidget.setEnabled(this.action.enabled);
	}

	public override focus(): void {
		this.pickerWidget.focus();
	}

	public openModelPicker(): void {
		this.focus();
		this.pickerWidget.show();
	}

	public override setTabbable(_tabbable: boolean): void {
		// Both picker triggers are page-level Tab stops, independent of ActionBar's current item.
		this.pickerWidget.setEnabled(this.action.enabled);
	}
}
