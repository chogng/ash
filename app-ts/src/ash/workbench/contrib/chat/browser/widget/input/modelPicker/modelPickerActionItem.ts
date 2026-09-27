import { ButtonActionViewItem } from '../../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../../../../platform/quickinput/common/quickInput.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

interface ModelPickerItem extends IQuickPickItem {
	readonly model?: ModelRef;
	readonly openSettings?: true;
}

export interface IModelPickerDelegate {
	getModels(): readonly ModelCatalogEntry[];
	getSelectedModel(): ModelRef | undefined;
	getModelsError(): string | undefined;
	selectModel(model: ModelRef): Promise<void>;
	openSettings(): Promise<void>;
}

/** Presents the shared model catalog through the workbench's searchable Quick Pick. */
export class ModelPickerActionItem extends ButtonActionViewItem {
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());

	constructor(action: IAction, private readonly delegate: IModelPickerDelegate, private readonly quickInputService: IQuickInputService) {
		super(action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-model-selector');
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-model-action', true);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		const indicator = h(container.ownerDocument, 'span');
		indicator.className = 'ash-dropdown-menu-indicator';
		appendIcon(Lxicon.chevronDown, indicator);
		this.button.domNode.append(indicator);
		this._register(toDisposable(() => indicator.remove()));
		this._register(addDisposableListener(this.button.domNode, 'keydown', this.handleKeydown));
	}

	protected override runAction(): void {
		this.show();
	}

	public show(): void {
		const models = this.delegate.getModels();
		const picker = this.quickInputService.createQuickPick<ModelPickerItem>();
		const session = new DisposableStore();
		session.add(picker);
		this.picker.value = session;
		picker.ariaLabel = localize('chat.modelPicker.aria', 'Choose a chat model');
		picker.placeholder = models.length
			? localize('chat.modelPicker.search', 'Search models')
			: localize('chat.modelPicker.noModelsPlaceholder', 'Set up models in Settings');
		picker.items = models.length ? models.map(entry => this.modelItem(entry)) : [{
			label: localize('chat.modelPicker.openSettings', 'Open Settings'),
			description: this.delegate.getModelsError()
				? localize('chat.modelPicker.loadFailed', 'Could not load models')
				: localize('chat.modelPicker.noModels', 'No models available'),
			openSettings: true,
		}];
		session.add(picker.onDidAccept(item => {
			if (item.model) {
				void this.delegate.selectModel(item.model).then(
					() => picker.hide(),
					() => { picker.placeholder = localize('chat.modelPicker.selectionFailed', 'Could not select model'); },
				);
			} else if (item.openSettings) {
				picker.hide();
				void this.delegate.openSettings();
			}
		}));
		session.add(picker.onDidHide(() => {
			if (this.picker.value === session) this.picker.clear();
		}));
		picker.show();
	}

	private modelItem(entry: ModelCatalogEntry): ModelPickerItem {
		const details: string[] = [];
		if (entry.contextWindow) details.push(localize('chat.modelPicker.context', '{0} context tokens', entry.contextWindow.toLocaleString()));
		if (entry.supportedReasoningEfforts?.length) details.push(localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.join(', ')));
		const selected = this.delegate.getSelectedModel();
		return {
			label: entry.displayName,
			description: `${entry.model.provider}/${entry.model.model}${selected?.provider === entry.model.provider && selected.model === entry.model.model ? ` · ${localize('chat.modelPicker.current', 'Current')}` : ''}`,
			detail: details.join(' · '),
			model: entry.model,
		};
	}

	private readonly handleKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		stopEvent(event);
		this.show();
	};
}
