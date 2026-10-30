import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { TabbedActionListWidget } from '../../../../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles, defaultToggleStyles, defaultMenuStyles, defaultKeybindingLabelStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import type { ModelRef, ModelProviderCredentialStatus } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ModelCard, type IModelCardOptions } from './modelPickerCard.js';
import { ModelPickerDetailsMenu } from './modelPickerHover.js';
import { buildModelPickerItems, createManageModelsAction } from './modelPickerItems.js';
import { buildModelPickerDestinations, type IModelPickerDestination } from './modelPickerTabs.js';
import { ModelPickerWelcome } from './modelPickerWelcome.js';

let nextPickerId = 0;

/** Projects provider tabs and detail pages; model state remains in the delegate and language-model service. */
export class TabbedModelPicker extends Disposable {
	private readonly widget: TabbedActionListWidget;
	private readonly showing = this._register(new MutableDisposable<DisposableStore>());
	private providers: readonly ModelProviderCredentialStatus[] = [];
	private activeCard: ModelCard | undefined;
	private detailsModel: ModelRef | undefined;
	private selecting = false;
	private preview: ModelPickerDetailsMenu | undefined;

	constructor(
		private readonly delegate: IModelPickerDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.widget = this._register(instantiationService.createInstance(TabbedActionListWidget));
	}

	public get isVisible(): boolean { return this.widget.isVisible; }
	public hide(): void { this.widget.hide(); }

	private get destinations(): readonly IModelPickerDestination[] {
		const manageModels = createManageModelsAction(this.commands);
		return buildModelPickerDestinations(this.delegate.getModels(), this.providers,
			this.providers.filter(provider => provider.configured && !provider.ready).map(provider => ({
				vendor: provider.connection, label: provider.displayName,
				message: localize('chat.modelPicker.providerNotReady', 'This connection is not ready. Check its configuration in Language Models.'),
				action: { label: manageModels.label, run: () => { this.hide(); void manageModels.run(); } },
			})));
	}

	public show(anchor: HTMLElement, detailsModel?: ModelRef): void {
		this.hide();
		const session = new DisposableStore();
		this.showing.value = session;
		const document = anchor.ownerDocument;
		const selected = this.delegate.getSelectedModel();
		const initialTab = this.destinations.find(tab => tab.id === (detailsModel ?? selected)?.provider)?.id ?? this.destinations[0]!.id;
		const pickerId = `chatModelPicker-${++nextPickerId}`;
		const manageModels = createManageModelsAction(this.commands);
		const empty = h(document, 'div');
		const welcome = session.add(new MutableDisposable<ModelPickerWelcome>());
		let welcomeKey: string | undefined;
		const fallbackPlaceholders = () => [{
			vendor: '',
			label: this.delegate.getModelsError()
				? localize('chat.modelPicker.loadFailed', 'Could not load models')
				: localize('chat.modelPicker.noModels', 'No models available'),
			message: localize('chat.modelPicker.noModelsPlaceholder', 'Set up models in Settings'),
			action: {
				label: localize('chat.modelPicker.openSettings', 'Open Settings'),
				run: () => { this.hide(); void this.delegate.openSettings(); },
			},
		}];
		const focusWelcome = (): void => welcome.value?.element.querySelector<HTMLElement>('button')?.focus();
		const error = h(document, 'div');
		error.className = 'ash-chat-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		let automaticSwitch: Switch | undefined;
		let popupRoot: HTMLElement | undefined;
		const owner = this;
		anchor.setAttribute('aria-expanded', 'true');
		this.widget.show<ModelCatalogEntry>({
			user: pickerId, anchor, width: 360,
			isBodyCollapsed: () => this.delegate.isAutomaticModel() && this.delegate.getModels().length > 0,
			focusFooter: () => automaticSwitch?.focus(),
			get tabs() { return owner.destinations; },
			initialTab,
			createActionList: provider => {
				const destination = this.destinations.find(destination => destination.id === provider)!;
				const current = this.delegate.isAutomaticModel() ? undefined : this.delegate.getSelectedModel();
				empty.hidden = destination.models.length > 0;
				if (!destination.models.length) {
					const placeholders = destination.placeholders.length ? destination.placeholders : fallbackPlaceholders();
					const key = JSON.stringify([provider, placeholders.map(({ label, message }) => [label, message])]);
					if (key !== welcomeKey) {
						const hadFocus = empty.contains(document.activeElement);
						welcomeKey = key;
						welcome.value = new ModelPickerWelcome({ ...destination, placeholders }, document);
						empty.replaceChildren(welcome.value.element);
						if (hadFocus) { focusWelcome(); }
					}
				}
				return {
					items: buildModelPickerItems([...destination.models].sort((left, right) => Number(this.languageModels.isModelPinned(right.model)) - Number(this.languageModels.isModelPinned(left.model))), current, {
						selectedEffort: this.delegate.getSelectedReasoningEffort(),
						onOpenDetails: entry => this.showDetails(entry),
					}),
					listOptions: {
						className: 'ash-chat-model-picker', presentation: 'details',
						ariaLabel: localize('chat.modelPicker.aria', 'Choose a chat model'),
						showFilter: true, filterVisible: destination.models.length > 0 && !this.delegate.isAutomaticModel(),
						filterPlaceholder: localize('chat.modelPicker.search', 'Search models'),
						focusFilterOnOpen: true, filterAsCombobox: true,
						itemsVisible: destination.models.length > 0 && !this.delegate.isAutomaticModel(), header: empty,
						accessibilityHelp: () => this.accessibleViewService.show(AccessibleViewType.Help),
					},
				};
			},
			delegate: {
				onSelect: async entry => {
					if (this.selecting) { return; }
					this.selecting = true;
					error.hidden = true;
					try {
						await this.delegate.selectModel(entry.model);
						if (!session.isDisposed) { this.hide(); }
					} catch {
						if (!session.isDisposed) {
							error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
							error.hidden = false;
						}
					} finally { this.selecting = false; }
				},
				onHover: (entry, row) => { if (!this.widget.isShowingDetails) { this.preview?.show(entry, row); } },
				onHide: () => {
					anchor.setAttribute('aria-expanded', 'false');
					this.activeCard = undefined;
					this.detailsModel = undefined;
					this.preview = undefined;
					this.showing.clear();
				},
			},
			renderWidget: root => {
				const resources = new DisposableStore();
				popupRoot = root;
				this.registerAccessibility(root, resources, pickerId);
				root.append(error);
				this.preview = resources.add(this.instantiationService.createInstance(ModelPickerDetailsMenu, root));
				for (const type of ['input', 'keydown', 'pointerdown'] as const) {
					resources.add(addDisposableListener(root, type, event => {
						if (!this.preview?.domNode.contains(event.target as Node)) { this.preview?.hide(); }
					}));
				}
				resources.add(addDisposableListener(root, 'keydown', event => {
					if (!event.isComposing && event.key === 'ArrowDown' && !empty.hidden && (event.target as HTMLElement).getAttribute('role') === 'tab') {
						stopEvent(event);
						focusWelcome();
					}
				}, true));
				return resources;
			},
			renderFooter: (container, provider) => {
				const resources = new DisposableStore();
				const automatic = resources.add(new Switch(container, {
					...defaultToggleStyles, label: localize('chat.modelPicker.auto', 'Auto'),
					ariaLabel: localize('chat.modelPicker.auto', 'Auto'), contentPlacement: 'before-control',
					checked: this.delegate.isAutomaticModel(),
				}));
				automaticSwitch = automatic;
				resources.add(automatic.onDidChange(async value => {
					if (this.selecting) { automatic.checked = this.delegate.isAutomaticModel(); return; }
					this.selecting = true;
					error.hidden = true;
					const hadFocus = document.activeElement === automatic.input;
					automatic.busy = true;
					try {
						if (value) { await this.delegate.selectAutomaticModel(); }
						else {
							const model = this.delegate.getSelectedModel() ?? this.delegate.getModels()[0]?.model;
							if (model) { await this.delegate.selectModel(model); }
						}
					} catch {
						if (!session.isDisposed) {
							error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
							error.hidden = false;
						}
					} finally {
						this.selecting = false;
						if (!resources.isDisposed) {
							automatic.busy = false;
							automatic.checked = this.delegate.isAutomaticModel();
							if (hadFocus) { automatic.focus(); }
						}
					}
				}));
				const menu = resources.add(new Menu(container, {
					buttonStyles: defaultButtonStyles, keybindingLabelStyles: defaultKeybindingLabelStyles,
					actions: [{ ...manageModels, run: () => { this.hide(); return manageModels.run(); } }],
				}, defaultMenuStyles));
				const refreshAutomatic = (): void => {
					const hasModels = this.delegate.getModels().length > 0;
					container.classList.toggle('ash-chat-model-picker-footer', hasModels);
					automatic.element.hidden = !hasModels;
					automatic.checked = this.delegate.isAutomaticModel();
					menu.element.hidden = !this.destinations.some(destination => destination.id === provider && destination.models.length > 0)
						|| this.delegate.isAutomaticModel();
				};
				refreshAutomatic();
				resources.add(this.delegate.onDidChangePresentation(refreshAutomatic));
				return resources;
			},
			openItemDetails: item => { this.showDetails(item.item!); return true; },
		});
		session.add(this.delegate.onDidChangePresentation(() => {
			const hadWelcomeFocus = welcome.value?.element.contains(document.activeElement);
			if (this.detailsModel && this.widget.isShowingDetails) {
				const entry = this.findModel(this.detailsModel);
				if (entry) { this.activeCard?.update(entry); }
				else { this.widget.hideDetails(); }
			}
			this.widget.refreshActiveList();
			if (!this.delegate.getModels().length) { focusWelcome(); }
			else if (hadWelcomeFocus && empty.hidden) { popupRoot?.querySelector<HTMLElement>('[role="combobox"]')?.focus(); }
		}));
		void this.languageModels.listModelProviders().then(providers => {
			if (session.isDisposed) { return; }
			this.providers = providers;
			this.widget.refreshActiveList();
		}).catch(() => { /* Catalog IDs remain valid provider labels while metadata is unavailable. */ });
		if (!this.delegate.getModels().length) { focusWelcome(); }
		if (detailsModel) {
			const entry = this.findModel(detailsModel);
			if (entry) { this.showDetails(entry); }
		}
	}

	private findModel(model: ModelRef): ModelCatalogEntry | undefined {
		return this.delegate.getModels().find(entry => entry.model.provider === model.provider && entry.model.model === model.model);
	}

	private showDetails(entry: ModelCatalogEntry): void {
		this.preview?.hide();
		this.detailsModel = entry.model;
		this.widget.showDetails({
			label: localize('chat.modelPicker.details', '{0} details', entry.displayName),
			backLabel: localize('chat.modelPicker.back', 'Back to models'),
			focus: () => this.activeCard?.focus(),
			render: container => {
				const resources = new DisposableStore();
				const cards = ModelCard.instantiateObservable(this.instantiationService, resources, container.ownerDocument, {
					getSelectedReasoningEffort: () => {
						const selected = this.delegate.getSelectedModel();
						return selected?.provider === entry.model.provider && selected.model === entry.model.model
							? this.delegate.getSelectedReasoningEffort() : undefined;
					},
					onReasoningEffortChange: async effort => {
						await this.selectForConfiguration(entry);
						const selected = this.delegate.getSelectedModel();
						if (resources.isDisposed || selected?.provider !== entry.model.provider || selected.model !== entry.model.model) { return; }
						await this.delegate.selectReasoningEffort(effort);
					},
					onAccelerationChange: async acceleration => {
						await this.selectForConfiguration(entry);
						if (resources.isDisposed) { return; }
						await this.languageModels.setModelPreferences(entry.model, { acceleration });
					},
					onLongContextChange: async longContext => {
						await this.selectForConfiguration(entry);
						if (resources.isDisposed) { return; }
						await this.languageModels.setModelPreferences(entry.model, { longContext });
					},
				} satisfies IModelCardOptions);
				const attach = (card: ModelCard): void => {
					this.activeCard = card;
					card.update(this.findModel(entry.model) ?? entry);
					container.replaceChildren(card.element);
				};
				attach(cards.get());
				resources.add(cards.onDidChange(attach));
				return resources;
			},
		});
	}

	private async selectForConfiguration(entry: ModelCatalogEntry): Promise<void> {
		const selected = this.delegate.getSelectedModel();
		if (this.delegate.isAutomaticModel() || selected?.provider !== entry.model.provider || selected.model !== entry.model.model) {
			await this.delegate.selectModel(entry.model);
		}
	}

	private registerAccessibility(root: HTMLElement, session: DisposableStore, id: string): void {
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', localize('chat.modelPicker.aria', 'Choose a chat model'));
		const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
		if (hint) { root.setAttribute('aria-description', hint); }
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			session.add(AccessibleViewRegistry.register({
				type, priority: 110, name: id,
				getProvider: () => {
					const active = root.ownerDocument.activeElement;
					if (!(active instanceof HTMLElement) || !root.contains(active)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type },
						() => type === AccessibleViewType.Help
							? localize('chat.modelPicker.help', 'Model picker. Provider tabs group models by connection. Left and Right Arrow move between tabs; Enter selects a tab and Down Arrow enters its models. Type in search to filter the active provider. Up and Down Arrow browse models and Enter selects one. The details button or Right Arrow opens model information and supported thinking, context and speed settings. Tab moves between controls; arrow keys change a focused option group. Applying settings selects that model. Back to models or Alt+Left Arrow returns to the retained list and search. Auto enables automatic model selection. Escape closes the picker. Add Models opens Language Models management.')
							: root.innerText,
						() => { if (active.isConnected) { active.focus(); } }, AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
	}
}
