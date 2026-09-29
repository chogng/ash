import './modelPicker.css';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import type { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { QuickInputList } from '../../../../../../../platform/quickinput/browser/quickInputList.js';
import type { IQuickPickItem } from '../../../../../../../platform/quickinput/common/quickInput.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';

interface ModelPickerItem extends IQuickPickItem {
	readonly model: ModelRef;
}

/** Owns the model picker popup, its search state, and transient listeners. */
export class ModelPickerWidget extends Disposable {
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private readonly contextView: ContextView;

	constructor(private readonly delegate: IModelPickerDelegate, contextViewService: IContextViewService) {
		super();
		this.contextView = this._register(new ContextView(contextViewService.container));
	}

	public get visible(): boolean {
		return this.contextView.visible;
	}

	public hide(): void {
		this.contextView.hide();
	}

	public show(anchor: HTMLElement): void {
		if (this.contextView.visible) return;
		const ownerDocument = anchor.ownerDocument;
		const models = this.delegate.getModels();
		const content = h(ownerDocument, 'div');
		content.className = 'ash-chat-model-picker';
		content.setAttribute('role', 'dialog');
		content.setAttribute('aria-label', localize('chat.modelPicker.aria', 'Choose a chat model'));
		const session = new DisposableStore();
		if (models.length === 0) {
			const empty = h(ownerDocument, 'div');
			empty.className = 'ash-chat-model-picker-empty';
			const message = h(ownerDocument, 'div');
			message.className = 'ash-chat-model-picker-empty-message';
			message.setAttribute('role', 'status');
			message.textContent = this.delegate.getModelsError()
				? localize('chat.modelPicker.loadFailed', 'Could not load models')
				: localize('chat.modelPicker.noModels', 'No models available');
			const guidance = h(ownerDocument, 'div');
			guidance.className = 'ash-chat-model-picker-empty-guidance';
			guidance.textContent = localize('chat.modelPicker.noModelsPlaceholder', 'Set up models in Settings');
			empty.append(message, guidance);
			const settingsButton = session.add(new Button(empty, {
				label: localize('chat.modelPicker.openSettings', 'Open Settings'),
				presentation: 'primary',
			}));
			session.add(settingsButton.onDidClick(() => {
				this.contextView.hide();
				void this.delegate.openSettings();
			}));
			content.append(empty);
			const shown = this.showContextView(anchor, content, session);
			if (shown) settingsButton.focus();
			return;
		}
		const searchContainer = h(ownerDocument, 'div');
		searchContainer.className = 'ash-chat-model-picker-search';
		const search = h(ownerDocument, 'input');
		search.type = 'search';
		search.setAttribute('role', 'combobox');
		search.setAttribute('aria-label', localize('chat.modelPicker.aria', 'Choose a chat model'));
		search.setAttribute('aria-autocomplete', 'list');
		search.setAttribute('aria-expanded', 'true');
		search.placeholder = localize('chat.modelPicker.search', 'Search models');
		searchContainer.append(search);
		const listContainer = h(ownerDocument, 'div');
		listContainer.className = 'ash-chat-model-picker-list';
		const error = h(ownerDocument, 'div');
		error.className = 'ash-chat-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		content.append(searchContainer, listContainer, error);

		if (!this.showContextView(anchor, content, session)) return;
		const list = session.add(new QuickInputList<ModelPickerItem>(listContainer, 'menu'));
		search.setAttribute('aria-controls', list.listId);
		session.add(list.onDidChangeActive(({ rowId }) => {
			if (rowId) search.setAttribute('aria-activedescendant', rowId);
			else search.removeAttribute('aria-activedescendant');
		}));
		list.items = models.map(entry => this.modelItem(entry));
		list.layout(360);
		this.contextView.layout();
		session.add(addDisposableListener(search, 'input', () => {
			list.filter(search.value);
			this.contextView.layout();
		}));
		session.add(addDisposableListener(search, 'keydown', event => {
			switch (event.key) {
				case 'ArrowDown':
					stopEvent(event);
					list.focusNext();
					break;
				case 'ArrowUp':
					stopEvent(event);
					list.focusPrevious();
					break;
				case 'Enter':
					stopEvent(event);
					list.acceptActive();
					break;
			}
		}));
		session.add(list.onDidAccept(item => {
			void this.delegate.selectModel(item.model).then(
				() => this.contextView.hide(),
				() => {
					if (!this.contextView.visible) return;
					error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
					error.hidden = false;
				},
			);
		}));
		search.focus();
	}

	private showContextView(anchor: HTMLElement, content: HTMLElement, session: DisposableStore): boolean {
		const shown = this.contextView.show({
			anchor,
			content,
			anchorPosition: AnchorPosition.Above,
			gap: 4,
			presentation: 'menu',
			focusRestore: ContextViewFocusRestore.Previous,
			layer: 20,
			onHide: () => {
				anchor.setAttribute('aria-expanded', 'false');
				this.popup.clear();
			},
		});
		if (!shown) {
			session.dispose();
			return false;
		}
		anchor.setAttribute('aria-expanded', 'true');
		this.popup.value = session;
		this.contextView.layout();
		return true;
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
}
