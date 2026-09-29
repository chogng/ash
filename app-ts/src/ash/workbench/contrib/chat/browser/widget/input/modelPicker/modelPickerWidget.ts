import './modelPicker.css';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import type { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { QuickInputList } from '../../../../../../../platform/quickinput/browser/quickInputList.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ModelPickerDetailsMenu } from './modelPickerHover.js';
import { buildModelPickerItems, type ModelPickerItem } from './modelPickerItems.js';

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
		const autoRow = h(ownerDocument, 'label');
		autoRow.className = 'ash-chat-model-picker-auto';
		const autoLabel = h(ownerDocument, 'span');
		autoLabel.textContent = localize('chat.modelPicker.auto', 'Auto');
		const autoSwitch = h(ownerDocument, 'input');
		autoSwitch.type = 'checkbox';
		autoSwitch.setAttribute('role', 'switch');
		autoSwitch.checked = this.delegate.isAutomaticModel();
		autoRow.append(autoLabel, autoSwitch);
		const listContainer = h(ownerDocument, 'div');
		listContainer.className = 'ash-chat-model-picker-list';
		const footer = h(ownerDocument, 'div');
		footer.className = 'ash-chat-model-picker-footer';
		const addModels = h(ownerDocument, 'button');
		addModels.type = 'button';
		addModels.textContent = localize('chat.modelPicker.addModels', 'Add Models');
		footer.append(addModels);
		const error = h(ownerDocument, 'div');
		error.className = 'ash-chat-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		content.append(searchContainer, autoRow, listContainer, footer, error);

		if (!this.showContextView(anchor, content, session)) return;
		const list = session.add(new QuickInputList<ModelPickerItem>(listContainer, 'menu'));
		const detailsMenu = new ModelPickerDetailsMenu(content);
		let hasNavigated = false;
		search.setAttribute('aria-controls', list.listId);
		session.add(list.onDidChangeActive(({ item, rowId }) => {
			if (rowId) search.setAttribute('aria-activedescendant', rowId);
			else search.removeAttribute('aria-activedescendant');
			if (hasNavigated && item && rowId) {
				const row = ownerDocument.getElementById(rowId);
				if (row) detailsMenu.show(item.entry, row);
			} else detailsMenu.hide();
		}));
		list.items = buildModelPickerItems(models, autoSwitch.checked ? undefined : this.delegate.getSelectedModel());
		list.layout(300);
		this.contextView.layout();
		session.add(addDisposableListener(listContainer, 'mousemove', event => {
			hasNavigated = true;
			const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.ash-list-row') : null;
			const item = list.activeItem;
			if (row && item) detailsMenu.show(item.entry, row);
		}));
		session.add(addDisposableListener(autoSwitch, 'change', () => {
			const isAutomatic = autoSwitch.checked;
			const selection = isAutomatic
				? this.delegate.selectAutomaticModel()
				: this.delegate.selectModel(this.delegate.getSelectedModel() ?? models[0].model);
			void selection.then(() => this.contextView.hide(), () => {
				autoSwitch.checked = !isAutomatic;
				error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
				error.hidden = false;
			});
		}));
		session.add(addDisposableListener(addModels, 'click', () => {
			this.contextView.hide();
			void this.delegate.openSettings();
		}));
		session.add(addDisposableListener(search, 'input', () => {
			hasNavigated = false;
			detailsMenu.hide();
			list.filter(search.value);
			this.contextView.layout();
		}));
		session.add(addDisposableListener(search, 'keydown', event => {
			switch (event.key) {
				case 'ArrowDown':
					stopEvent(event);
					hasNavigated = true;
					list.focusNext();
					break;
				case 'ArrowUp':
					stopEvent(event);
					hasNavigated = true;
					list.focusPrevious();
					break;
				case 'Enter':
					stopEvent(event);
					list.acceptActive();
					break;
			}
		}));
		session.add(list.onDidAccept(item => {
			void this.delegate.selectModel(item.entry.model).then(
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
}
