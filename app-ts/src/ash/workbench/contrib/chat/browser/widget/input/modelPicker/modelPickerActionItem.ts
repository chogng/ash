import { ButtonActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { addDisposableListener, stopEvent } from '../../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../../base/common/event.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { ModelPickerWidget } from './modelPickerWidget.js';

export interface IModelPickerDelegate {
	readonly onDidChangePresentation: Event<void>;
	getModels(): readonly ModelCatalogEntry[];
	getSelectedModel(): ModelRef | undefined;
	isAutomaticModel(): boolean;
	getModelsError(): string | undefined;
	selectModel(model: ModelRef): Promise<void>;
	selectAutomaticModel(): Promise<void>;
	openSettings(): Promise<void>;
}

/** Presents the model picker as a Chat input action. */
export class ModelPickerActionItem extends ButtonActionViewItem {
	private readonly pickerWidget: ModelPickerWidget;

	constructor(action: IAction, private readonly delegate: IModelPickerDelegate, @IInstantiationService instantiationService: IInstantiationService) {
		super(action);
		this.pickerWidget = this._register(instantiationService.createInstance(ModelPickerWidget, delegate));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-model-selector');
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-model-action', true);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.delegate.onDidChangePresentation(() => {
			this.button.label = this.action.label;
			this.button.domNode.setAttribute('aria-label', this.action.tooltip);
			this.setupTooltip();
		}));
		this._register(addDisposableListener(this.button.domNode, 'keydown', this.handleKeydown));
	}

	protected override runAction(): void {
		if (this.pickerWidget.visible) {
			this.pickerWidget.hide();
			return;
		}
		this.show();
	}

	public show(): void {
		this.pickerWidget.show(this.button.domNode);
	}

	private readonly handleKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		stopEvent(event);
		this.show();
	};
}
