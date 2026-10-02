import './modelPicker.css';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { IContextViewService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { QuickInputList } from '../../../../../../../platform/quickinput/browser/quickInputList.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { ModelPickerDetailsMenu } from './modelPickerHover.js';
import { buildModelPickerItems, type ModelPickerItem } from './modelPickerItems.js';

let nextPickerId = 0;

/** Owns the model picker popup, its search state, and transient listeners. */
export class ModelPickerWidget extends Disposable {
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private readonly contextView: ContextView;

	constructor(private readonly delegate: IModelPickerDelegate, @IContextViewService contextViewService: IContextViewService, @IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService) {
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
		let models = this.delegate.getModels();
		const content = h(ownerDocument, 'div');
		content.className = 'ash-chat-model-picker';
		content.setAttribute('role', 'dialog');
		content.setAttribute('aria-label', localize('chat.modelPicker.aria', 'Choose a chat model'));
		const session = new DisposableStore();
		const pickerId = ++nextPickerId;
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			session.add(AccessibleViewRegistry.register({
				type,
				priority: 110,
				name: `chatModelPicker-${pickerId}`,
				getProvider: () => {
					const active = ownerDocument.activeElement;
					if (!(active instanceof HTMLElement) || !content.contains(active)) { return undefined; }
					return new AccessibleContentProvider(
						AccessibleViewProviderId.ChatModelConfiguration,
						{ type },
						() => {
							if (type === AccessibleViewType.Help) {
								return localize('chat.modelPicker.help', 'Model menu. Space toggles Auto. When Auto is on, only its switch is shown. When Auto is off, type to search, use Up and Down Arrow to browse models, and Enter to select. Right Arrow opens model settings. Space toggles Fast or the context window when supported. Use the thinking effort menu beside the model button to change thinking level. Alt+Left Arrow returns to search. Escape closes the menu.');
							}
							return content.innerText;
						},
						() => { if (active.isConnected) { active.focus(); } },
						AccessibilityVerbositySettingId.ChatModelConfiguration,
					);
				},
			}));
		}
		const descriptions = new WeakMap<HTMLElement, string>();
		session.add(addDisposableListener(content, 'focusin', event => {
			const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			if (event.target instanceof HTMLElement) {
				if (!descriptions.has(event.target)) { descriptions.set(event.target, event.target.getAttribute('aria-description') ?? ''); }
				const description = [descriptions.get(event.target), hint].filter(Boolean).join(' ');
				if (description) { event.target.setAttribute('aria-description', description); }
				else { event.target.removeAttribute('aria-description'); }
			}
		}));
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
		const autoRow = h(ownerDocument, 'div');
		autoRow.className = 'ash-chat-model-picker-auto';
		const autoSwitch = session.add(new Switch(autoRow, {
			label: localize('chat.modelPicker.auto', 'Auto'),
			ariaLabel: localize('chat.modelPicker.auto', 'Auto'),
			checked: this.delegate.isAutomaticModel(),
			contentPlacement: 'before-control',
		}));
		const listContainer = h(ownerDocument, 'div');
		listContainer.className = 'ash-chat-model-picker-list';
		const footer = h(ownerDocument, 'div');
		footer.className = 'ash-chat-model-picker-footer';
		session.add(new Menu(footer, {
			actions: [{
				id: 'ash.chat.input.addModels',
				label: localize('chat.modelPicker.addModels', 'Add Models'),
				tooltip: '',
				enabled: true,
				run: () => {
					this.contextView.hide();
					return this.delegate.openSettings();
				},
			}],
		}));
		const error = h(ownerDocument, 'div');
		error.className = 'ash-chat-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		content.append(searchContainer, autoRow, listContainer, footer, error);
		searchContainer.hidden = autoSwitch.checked;
		listContainer.hidden = autoSwitch.checked;
		footer.hidden = autoSwitch.checked;

		if (!this.showContextView(anchor, content, session)) return;
		const list = session.add(new QuickInputList<ModelPickerItem>(listContainer, 'compactMenu'));
		const detailsMenu = session.add(new ModelPickerDetailsMenu(content));
		let hasNavigated = false;
		let updatingModels = false;
		const showDetails = (item: ModelPickerItem, row: HTMLElement): void => {
			detailsMenu.show({
				entry: item.entry,
				setPreferences: update => this.languageModels.setModelPreferences(item.entry.model, update),
			}, row);
		};
		const showActiveDetails = (): void => {
			const rowId = search.getAttribute('aria-activedescendant');
			const row = rowId ? ownerDocument.getElementById(rowId) : null;
			if (list.activeItem && row) { showDetails(list.activeItem, row); }
		};
		search.setAttribute('aria-controls', list.listId);
		session.add(list.onDidChangeActive(({ item, rowId }) => {
			if (rowId) search.setAttribute('aria-activedescendant', rowId);
			else search.removeAttribute('aria-activedescendant');
			if (updatingModels) { return; }
			if (hasNavigated && item && rowId) {
				const row = ownerDocument.getElementById(rowId);
				if (row) showDetails(item, row);
			} else detailsMenu.hide();
		}));
		list.layout(300);
		let renderedModels: readonly ModelPickerItem['entry'][] | undefined;
		let renderedSelection: ModelRef | undefined;
		let renderedAutomatic: boolean | undefined;
		const renderMode = (): void => {
			models = this.delegate.getModels();
			autoSwitch.checked = this.delegate.isAutomaticModel();
			const isAutomatic = autoSwitch.checked;
			const selected = this.delegate.getSelectedModel();
			const modeChanged = renderedAutomatic !== isAutomatic;
			const modelsChanged = renderedModels?.length !== models.length || models.some((entry, index) => renderedModels?.[index] !== entry);
			const selectionChanged = renderedSelection?.provider !== selected?.provider || renderedSelection?.model !== selected?.model;
			searchContainer.hidden = isAutomatic;
			listContainer.hidden = isAutomatic;
			footer.hidden = isAutomatic;
			if (modeChanged) {
				hasNavigated = false;
				detailsMenu.hide();
			}
			if (modeChanged || modelsChanged || selectionChanged) {
				const activeModel = list.activeItem?.entry.model;
				// Restoring the active row must not replace the card through intermediate list selections.
				updatingModels = true;
				list.items = isAutomatic ? [] : buildModelPickerItems(models, selected);
				const activeIndex = list.visibleItems.findIndex(item => item.entry.model.provider === activeModel?.provider && item.entry.model.model === activeModel?.model);
				const currentIndex = list.activeItem ? list.visibleItems.indexOf(list.activeItem) : -1;
				if (activeIndex >= 0) {
					for (let index = currentIndex; index < activeIndex; index++) { list.focusNext(); }
					for (let index = currentIndex; index > activeIndex; index--) { list.focusPrevious(); }
				}
				updatingModels = false;
			}
			renderedModels = models;
			renderedSelection = selected;
			renderedAutomatic = isAutomatic;
			if (hasNavigated && !isAutomatic) { showActiveDetails(); }
			this.contextView.layout();
		};
		renderMode();
		session.add(this.delegate.onDidChangePresentation(renderMode));
		session.add(addDisposableListener(listContainer, 'mousemove', event => {
			hasNavigated = true;
			const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.ash-list-row') : null;
			const item = list.activeItem;
			if (row && item) showDetails(item, row);
		}));
		session.add(autoSwitch.onDidChange(async isAutomatic => {
			const hadFocus = ownerDocument.activeElement === autoSwitch.input;
			autoSwitch.busy = true;
			error.hidden = true;
			try {
				if (isAutomatic) {
					await this.delegate.selectAutomaticModel();
				} else {
					await this.delegate.selectModel(this.delegate.getSelectedModel() ?? models[0].model);
				}
			} catch {
				if (session.isDisposed) return;
				error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
				error.hidden = false;
			} finally {
				if (!session.isDisposed) {
					autoSwitch.checked = this.delegate.isAutomaticModel();
					autoSwitch.busy = false;
					renderMode();
					if (hadFocus) autoSwitch.focus();
				}
			}
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
				case 'ArrowRight':
					stopEvent(event);
					hasNavigated = true;
					showActiveDetails();
					detailsMenu.focus();
					break;
				case 'Enter':
					stopEvent(event);
					list.acceptActive();
					break;
			}
		}));
		session.add(addDisposableListener(listContainer, 'keydown', event => {
			if (event.key === 'ArrowRight') {
				stopEvent(event);
				hasNavigated = true;
				showActiveDetails();
				detailsMenu.focus();
			}
		}));
		session.add(addDisposableListener(detailsMenu.domNode, 'keydown', event => {
			if (event.key === 'ArrowLeft' && event.altKey) { stopEvent(event); search.focus(); }
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
		if (autoSwitch.checked) autoSwitch.focus();
		else search.focus();
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
