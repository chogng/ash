import { ButtonActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { addDisposableListener, stopEvent } from '../../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import type { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { ModelPickerWidget } from './modelPickerWidget.js';

export interface IModelPickerDelegate {
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

	constructor(action: IAction, delegate: IModelPickerDelegate, contextViewService: IContextViewService) {
		super(action);
		this.pickerWidget = this._register(new ModelPickerWidget(delegate, contextViewService));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-model-selector');
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-model-action', true);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
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
