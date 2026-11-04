import { Action, SubmenuAction } from '../../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
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
import { buildModelPickerItems, createManageModelsAction } from './modelPickerItems.js';
import { buildModelPickerDestinations, type IModelPickerDestination } from './modelPickerTabs.js';
import { modelPickerEffortOptions } from './modelPickerModelConfig.js';
import { ModelPickerWelcome } from './modelPickerWelcome.js';

let nextPickerId = 0;

/** Presents the enabled catalog and detail pages; model state remains in the delegate and language-model service. */
export class TabbedModelPicker extends Disposable {
	private readonly widget: TabbedActionListWidget;
	private readonly showing = this._register(new MutableDisposable<DisposableStore>());
	private providers: readonly ModelProviderCredentialStatus[] = [];
	private activeCard: ModelCard | undefined;
	private detailsModel: ModelRef | undefined;
	private selecting = false;

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

	public show(anchor: HTMLElement, detailsModel?: ModelRef, configureInMenu = false): void {
		this.hide();
		const session = new DisposableStore();
		this.showing.value = session;
		const document = anchor.ownerDocument;
		const pickerId = `chatModelPicker-${++nextPickerId}`;
		const addModels = createManageModelsAction(this.commands);
		const manageModels = configureInMenu
			? { ...addModels, label: localize('chat.modelPicker.moreModels', 'More Models') }
			: addModels;
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
		const renderAutomatic = (container: HTMLElement): DisposableStore => {
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
					if (value) { await this.delegate.selectAutomaticModel?.(); }
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
			const refresh = (): void => {
				automatic.element.hidden = !this.delegate.getModels().length;
				automatic.checked = this.delegate.isAutomaticModel();
			};
			refresh();
			resources.add(this.delegate.onDidChangePresentation(refresh));
			return resources;
		};
		this.widget.show<ModelCatalogEntry>({
			user: pickerId, anchor, width: 240,
			isBodyCollapsed: () => this.delegate.isAutomaticModel() && this.delegate.getModels().length > 0,
			focusFooter: () => automaticSwitch?.focus(),
			tabs: [], initialTab: '',
			createActionList: () => {
				const models = this.delegate.getModels();
				const current = this.delegate.isAutomaticModel() ? undefined : this.delegate.getSelectedModel();
				empty.hidden = models.length > 0;
				if (!models.length) {
					const destinations = this.destinations;
					const unavailable = destinations.flatMap(destination => destination.placeholders);
					const placeholders = unavailable.length ? unavailable : fallbackPlaceholders();
					const key = JSON.stringify(placeholders.map(({ label, message }) => [label, message]));
					if (key !== welcomeKey) {
						const hadFocus = empty.contains(document.activeElement);
						welcomeKey = key;
						welcome.value = new ModelPickerWelcome({ ...destinations[0]!, placeholders }, document);
						empty.replaceChildren(welcome.value.element);
						if (hadFocus) { focusWelcome(); }
					}
				}
				return {
					items: buildModelPickerItems(models, current),
					listOptions: {
						className: 'ash-chat-model-picker ash-action-widget-accent-checks', presentation: 'details',
						ariaLabel: localize('chat.modelPicker.aria', 'Choose a chat model'),
						showFilter: true, filterVisible: models.length > 0 && !this.delegate.isAutomaticModel(),
						filterPlaceholder: localize('chat.modelPicker.search', 'Search models'),
						focusFilterOnOpen: true, filterAsCombobox: true,
						itemsVisible: models.length > 0 && !this.delegate.isAutomaticModel(), header: empty,
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
				onHide: () => {
					this.activeCard = undefined;
					this.detailsModel = undefined;
					this.showing.clear();
				},
			},
			renderHover: (entry, container) => {
				if (!entry.description?.trim() && !(entry.maximumContextWindow ?? entry.contextWindow)) return undefined;
				const resources = new DisposableStore();
				const cards = ModelCard.instantiateObservable(this.instantiationService, resources, container.ownerDocument, undefined);
				const render = (card: ModelCard): void => {
					const hadFocus = container.contains(container.ownerDocument.activeElement);
					card.update(entry);
					container.replaceChildren(card.element);
					if (hadFocus) { card.focus(); }
				};
				render(cards.get());
				resources.add(cards.onDidChange(render));
				return resources;
			},
			renderWidget: root => {
				const resources = new DisposableStore();
				popupRoot = root;
				this.registerAccessibility(root, resources, pickerId, configureInMenu);
				root.append(error);
				return resources;
			},
			renderHeader: configureInMenu && this.delegate.selectAutomaticModel ? container => {
				container.classList.add('ash-chat-model-picker-automatic');
				return renderAutomatic(container);
			} : undefined,
			renderFooter: (container, _tab, sidePanel) => {
				const resources = new DisposableStore();
				if (!configureInMenu && this.delegate.selectAutomaticModel) { resources.add(renderAutomatic(container)); }
				const effortSection = h(document, 'div', { className: 'ash-chat-model-picker-section' });
				const moreSection = h(document, 'div', { className: configureInMenu ? 'ash-chat-model-picker-section' : '' });
				const fastSection = h(document, 'div', { className: 'ash-chat-model-picker-section' });
				container.append(effortSection, moreSection, fastSection);
				const configurationResources = resources.add(new DisposableStore());
				let configurationKey: string | undefined;
				let effortActions: Action[] = [];
				let fast: Switch | undefined;
				const refreshConfiguration = (): void => {
					if (!configureInMenu) { return; }
					const selected = this.delegate.getSelectedModel();
					const entry = this.delegate.isAutomaticModel() ? undefined : selected && this.findModel(selected);
					const efforts = entry?.supportedReasoningEfforts?.length
						? modelPickerEffortOptions(entry, this.delegate.getSelectedReasoningEffort()) : [];
					const acceleration = entry?.accelerationOptions?.find(option => option.name === 'Fast');
					const key = JSON.stringify([entry?.model, efforts.map(option => option.value), acceleration?.id]);
					if (key !== configurationKey) {
						const active = document.activeElement;
						const hadFocus = active && (effortSection.contains(active) || fastSection.contains(active) || sidePanel?.contains(active));
						configurationKey = key;
						configurationResources.clear();
						effortSection.replaceChildren();
						fastSection.replaceChildren();
						fast = undefined;
						effortActions = efforts.map((option, index) => configurationResources.add(new Action(
							`chat.modelPicker.effort.${index}`, option.label, undefined, true,
							() => updateConfiguration(() => this.delegate.selectReasoningEffort(option.value)),
						)));
						if (effortActions.length) {
							configurationResources.add(new Menu(effortSection, [new SubmenuAction(
								'chat.modelPicker.effort', localize('chat.modelPicker.thinkingEffort', 'Effort'), effortActions, Lxicon.brain,
							)], {
								buttonStyles: defaultButtonStyles,
								keybindingLabelStyles: defaultKeybindingLabelStyles,
								getCheckedActionsRepresentation: () => 'radio',
								submenuVerticalAlignment: 'bottom',
								tabLeavesSubmenu: true,
								submenuContextView: sidePanel,
							}, defaultMenuStyles));
						}
						if (entry && acceleration) {
							const label = localize('chat.modelPicker.fastMode', 'Fast Mode');
							const content = h(document, 'span', { className: 'ash-chat-model-picker-fast-label' });
							appendIcon(Lxicon.lightning, content);
							content.append(label);
							const toggle = configurationResources.add(new Switch(fastSection, {
								...defaultToggleStyles, content, ariaLabel: label, contentPlacement: 'before-control',
							}));
							fast = toggle;
							configurationResources.add(toggle.onDidChange(async value => {
								const hadFocus = document.activeElement === toggle.input;
								await updateConfiguration(() => this.languageModels.setModelPreferences(entry.model, { acceleration: value ? acceleration.id : null }));
								if (hadFocus && toggle.input.isConnected && document.activeElement === document.body) { toggle.focus(); }
							}));
						}
						if (hadFocus) { automaticSwitch?.focus(); }
					}
					for (const [index, action] of effortActions.entries()) {
						action.checked = efforts[index]!.checked;
						action.enabled = !this.selecting;
					}
					if (fast) {
						fast.checked = !!acceleration && entry?.selectedAcceleration === acceleration.id;
						fast.busy = this.selecting;
					}
				};
				const updateConfiguration = async (update: () => Promise<unknown>): Promise<void> => {
					if (this.selecting) { refreshConfiguration(); return; }
					this.selecting = true;
					error.hidden = true;
					refreshConfiguration();
					try {
						await update();
					} catch {
						if (!resources.isDisposed) {
							error.textContent = localize('chat.modelPicker.configurationFailed', 'Could not update model settings');
							error.hidden = false;
						}
					} finally {
						this.selecting = false;
						if (!resources.isDisposed) { refreshConfiguration(); }
					}
				};
				const alternate = this.delegate.alternateModelAction;
				const actions = [{ ...manageModels, run: () => { this.hide(); return manageModels.run(); } }];
				if (alternate) actions.push({ ...alternate, run: () => { this.hide(); return alternate.run(); } });
				resources.add(new Menu(moreSection, actions, {
					buttonStyles: defaultButtonStyles, keybindingLabelStyles: defaultKeybindingLabelStyles
				}, defaultMenuStyles));
				const refreshFooter = (): void => {
					const hasModels = this.delegate.getModels().length > 0;
					container.classList.toggle('ash-chat-model-picker-footer', hasModels);
					container.classList.toggle('has-divider', hasModels && !configureInMenu);
					moreSection.hidden = !alternate && (!hasModels || (!configureInMenu && this.delegate.isAutomaticModel()));
					refreshConfiguration();
				};
				refreshFooter();
				resources.add(this.delegate.onDidChangePresentation(refreshFooter));
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

	private registerAccessibility(root: HTMLElement, session: DisposableStore, id: string, configureInMenu: boolean): void {
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
							? configureInMenu
								? localize('chat.modelPicker.menuHelp', 'Model picker. Type to filter models. Use Up and Down Arrow to browse, Enter to select, and Right Arrow on a model to open its details. Tab to the Effort submenu and press Right Arrow to choose a level. Tab to Fast Mode and press Space to toggle it. Auto enables automatic model selection. More Models opens Language Models management. Escape closes the current menu.')
								: localize('chat.modelPicker.help', 'Model picker. All enabled models appear in one list. Type in search to filter models across all providers. Up and Down Arrow browse models and Enter selects one. Right Arrow opens model information and supported thinking, context and speed settings. Tab moves between controls; arrow keys change a focused option group. Applying settings selects that model. Back to models or Alt+Left Arrow returns to the retained list and search. Auto enables automatic model selection. Escape closes the picker. Add Models opens Language Models management.')
							: root.innerText,
						() => { if (active.isConnected) { active.focus(); } }, AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
	}
}
