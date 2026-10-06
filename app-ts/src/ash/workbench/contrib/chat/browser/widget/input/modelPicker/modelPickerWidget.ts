import './modelPicker.css';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { EventType, Gesture } from '../../../../../../../base/browser/touch.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IActionWidgetService } from '../../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { ModelPickerDetailsMenu } from './modelPickerHover.js';
import { buildModelPickerItems } from './modelPickerItems.js';
import { ModelPickerConfiguration } from './modelPickerConfiguration.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { renderChatInputPickerSplit, trackChatInputPickerFocus } from '../chatInputPickerActionItem.js';

let nextPickerId = 0;

/** Model controls retain business state; ActionWidget owns the popup and its action list. */
export class ModelPickerWidget extends Disposable {
	private nameButton: HTMLElement | undefined;
	private configurationButton: HTMLElement | undefined;
	private readonly nameHover = this._register(new MutableDisposable<IManagedHover>());
	private configuration: ModelPickerConfiguration | undefined;
	private enabled = true;
	private readonly popup: MutableDisposable<DisposableStore>;

	constructor(private readonly delegate: IModelPickerDelegate, @IActionWidgetService private readonly actionWidgetService: IActionWidgetService, @IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService, @IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
		// Close the service-owned popup before releasing the controls attached to it.
		this._register(toDisposable(() => this.hide()));
		this.popup = this._register(new MutableDisposable<DisposableStore>());
	}

	public render(container: HTMLElement): void {
		const control = h(container.ownerDocument, 'div');
		control.className = 'ash-chat-model-picker-control';
		container.append(control);
		this._register(toDisposable(() => control.remove()));
		const { primaryButton: name, secondaryButton: options } = renderChatInputPickerSplit(control);
		this._register(trackChatInputPickerFocus(control));
		this.nameButton = name;
		this.configurationButton = options;
		name.classList.add('ash-chat-input-model-action');
		options.classList.add('ash-chat-input-configuration-action');
		name.setAttribute('aria-haspopup', 'dialog');
		options.setAttribute('aria-haspopup', 'menu');
		this.configuration = this._register(this.instantiationService.createInstance(ModelPickerConfiguration, this.delegate, options));
		this.bindTrigger(name, () => {
			name.focus();
			if (this.visible) { this.hide(); }
			else { this.show(name); }
		});
		this.bindTrigger(options, () => {
			this.hide();
			options.focus();
			this.configuration!.show();
		});
		this._register(addDisposableListener(control, 'keydown', event => {
			if (!this.enabled || event.isComposing) { return; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				stopEvent(event);
				if (event.target === name) { this.show(name); }
				else { this.configuration!.show(); }
			} else if (event.key === 'ArrowRight' && event.target === name && !options.hidden) {
				stopEvent(event);
				options.focus();
			} else if (event.key === 'ArrowLeft' && event.target === options) {
				stopEvent(event);
				name.focus();
			}
		}));
		this._register(this.delegate.onDidChangePresentation(() => this.updateButtons()));
		this.updateButtons();
	}

	private bindTrigger(trigger: HTMLElement, activate: () => void): void {
		this._register(addDisposableListener(trigger, 'mousedown', event => {
			if (event.button !== 0 || trigger.getAttribute('aria-disabled') === 'true') { return; }
			stopEvent(event);
			activate();
		}));
		this._register(addDisposableListener(trigger, 'keydown', event => {
			if (event.isComposing || (event.key !== 'Enter' && event.key !== ' ') || trigger.getAttribute('aria-disabled') === 'true') { return; }
			stopEvent(event);
			activate();
		}));
		this._register(Gesture.addTarget(trigger));
		this._register(addDisposableListener(trigger, EventType.Tap, event => {
			stopEvent(event);
			if (this.enabled) { activate(); }
		}));
	}

	public focus(): void {
		this.nameButton?.focus();
	}

	public setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		for (const button of [this.nameButton!, this.configurationButton!]) {
			button.setAttribute('aria-disabled', String(!enabled));
			button.tabIndex = enabled && !button.hidden ? 0 : -1;
		}
		if (!enabled) { this.hide(); }
	}

	private updateButtons(): void {
		const selected = this.delegate.getSelectedModel();
		const model = this.delegate.getModels().find(entry => entry.model.provider === selected?.provider && entry.model.model === selected.model);
		const label = this.delegate.isAutomaticModel()
			? localize('chat.modelPicker.auto', 'Auto')
			: model?.displayName ?? localize('chat.modelPicker.selectModel', 'Select model');
		this.nameButton!.querySelector('.ash-chat-input-picker-label')!.textContent = label;
		this.nameButton!.setAttribute('aria-label', label);
		this.nameHover.clear();
		this.nameHover.value = getHoverDelegate().setupHover({ target: this.nameButton!, content: label, groupId: 'actions' });
		this.configuration!.renderButton();
		if (this.configurationButton!.hidden && this.configurationButton!.ownerDocument.activeElement === this.configurationButton) { this.focus(); }
		this.setEnabled(this.enabled);
	}

	public get visible(): boolean {
		return this.popup.value !== undefined;
	}

	public hide(): void {
		if (this.visible) {
			this.actionWidgetService.hide();
		}
	}

	public show(anchor: HTMLElement = this.nameButton!): void {
		if (this.visible || !this.enabled) return;
		const ownerDocument = anchor.ownerDocument;
		let models = this.delegate.getModels();
		const session = new DisposableStore();
		const pickerId = ++nextPickerId;
		const header = h(ownerDocument, 'div');
		const footer = h(ownerDocument, 'div');
		footer.className = 'ash-chat-model-picker-footer';
		const error = h(ownerDocument, 'div');
		error.className = 'ash-chat-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		let autoSwitch: Switch | undefined;
		if (models.length === 0) {
			header.className = 'ash-chat-model-picker-empty';
			const message = h(ownerDocument, 'div');
			message.className = 'ash-chat-model-picker-empty-message';
			message.setAttribute('role', 'status');
			message.textContent = this.delegate.getModelsError()
				? localize('chat.modelPicker.loadFailed', 'Could not load models')
				: localize('chat.modelPicker.noModels', 'No models available');
			const guidance = h(ownerDocument, 'div');
			guidance.className = 'ash-chat-model-picker-empty-guidance';
			guidance.textContent = localize('chat.modelPicker.noModelsPlaceholder', 'Set up models in Settings');
			header.append(message, guidance);
			const settingsButton = session.add(new Button(header, {
				label: localize('chat.modelPicker.openSettings', 'Open Settings'),
				presentation: 'primary',
			}));
			session.add(settingsButton.onDidClick(() => {
				this.hide();
				void this.delegate.openSettings();
			}));
		} else {
			header.className = 'ash-chat-model-picker-auto';
			autoSwitch = session.add(new Switch(header, {
				label: localize('chat.modelPicker.auto', 'Auto'),
				ariaLabel: localize('chat.modelPicker.auto', 'Auto'),
				checked: this.delegate.isAutomaticModel(),
				contentPlacement: 'before-control',
			}));
			session.add(new Menu(footer, {
				actions: [{
					id: 'ash.chat.input.addModels',
					label: localize('chat.modelPicker.addModels', 'Add Models'),
					tooltip: '',
					enabled: true,
					run: () => {
						this.hide();
						return this.delegate.openSettings();
					},
				}],
			}));
		}
		let active: { entry: ModelCatalogEntry; row: HTMLElement; } | undefined;
		let detailsMenu: ModelPickerDetailsMenu;
		let hasNavigated = false;
		const showDetails = (): void => {
			if (active && hasNavigated) {
				const { entry, row } = active;
				detailsMenu.show({
					entry,
					setPreferences: update => this.languageModels.setModelPreferences(entry.model, update),
				}, row);
			}
		};
		const isAutomatic = this.delegate.isAutomaticModel();
		footer.hidden = models.length === 0 || isAutomatic;
		this.popup.value = session;
		anchor.setAttribute('aria-expanded', 'true');
		this.actionWidgetService.show(`chatModelPicker-${pickerId}`, false, isAutomatic ? [] : buildModelPickerItems(models, this.delegate.getSelectedModel()), {
			onShow: content => {
				this.registerAccessibility(content, session, pickerId);
				content.append(error);
				detailsMenu = session.add(new ModelPickerDetailsMenu(content));
				session.add(addDisposableListener(content, 'keydown', event => {
					if (event.isComposing) return;
					if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						hasNavigated = true;
					} else if (event.key === 'ArrowRight' && !detailsMenu.domNode.contains(event.target as Node)) {
						stopEvent(event);
						hasNavigated = true;
						this.actionWidgetService.focus();
						showDetails();
						detailsMenu.focus();
					} else if (event.key === 'ArrowLeft' && event.altKey) {
						stopEvent(event);
						this.actionWidgetService.focusFilter();
					}
				}, true));
				session.add(addDisposableListener(content, 'input', event => {
					if (event.target instanceof HTMLElement && event.target.getAttribute('type') === 'search') {
						hasNavigated = false;
						detailsMenu.hide();
					}
				}));
			},
			onFocus: (entry, row) => {
				active = { entry, row };
				showDetails();
			},
			onHover: (entry, row) => {
				active = { entry, row };
				hasNavigated = true;
				showDetails();
			},
			onSelect: async entry => {
				try {
					await this.delegate.selectModel(entry.model);
					if (!session.isDisposed) this.actionWidgetService.hide(false);
				} catch {
					if (session.isDisposed) return;
					error.textContent = localize('chat.modelPicker.selectionFailed', 'Could not select model');
					error.hidden = false;
				}
			},
			onHide: () => {
				anchor.setAttribute('aria-expanded', 'false');
				this.popup.clear();
			},
		}, anchor, {
			className: 'ash-chat-model-picker',
			presentation: 'details',
			ariaLabel: localize('chat.modelPicker.aria', 'Choose a chat model'),
			showFilter: models.length > 0,
			filterPlaceholder: localize('chat.modelPicker.search', 'Search models'),
			focusFilterOnOpen: true,
			filterAsCombobox: true,
			filterVisible: !isAutomatic,
			itemsVisible: models.length > 0 && !isAutomatic,
			minWidth: 180,
			header,
			footer,
			accessibilityHelp: () => { this.accessibleViewService.show(AccessibleViewType.Help); },
		});
		if (!autoSwitch) {
			header.querySelector<HTMLButtonElement>('button')!.focus();
			return;
		}
		const modeSwitch = autoSwitch;
		let renderedModels = models;
		let renderedSelected = this.delegate.getSelectedModel();
		let renderedAutomatic = isAutomatic;
		const renderMode = (): void => {
			models = this.delegate.getModels();
			const automatic = this.delegate.isAutomaticModel();
			const selected = this.delegate.getSelectedModel();
			const modeChanged = automatic !== renderedAutomatic;
			const modelsChanged = renderedModels.length !== models.length || models.some((entry, index) => renderedModels[index] !== entry);
			const selectionChanged = renderedSelected?.provider !== selected?.provider || renderedSelected?.model !== selected?.model;
			modeSwitch.checked = automatic;
			footer.hidden = automatic;
			if (modeChanged) {
				hasNavigated = false;
				active = undefined;
				detailsMenu.hide();
			}
			if (modeChanged || modelsChanged || selectionChanged) {
				this.actionWidgetService.updateItems(automatic ? [] : buildModelPickerItems(models, selected), { filterVisible: !automatic, itemsVisible: !automatic });
			}
			renderedModels = models;
			renderedSelected = selected;
			renderedAutomatic = automatic;
		};
		session.add(this.delegate.onDidChangePresentation(renderMode));
		session.add(modeSwitch.onDidChange(async automatic => {
			const hadFocus = ownerDocument.activeElement === modeSwitch.input;
			modeSwitch.busy = true;
			error.hidden = true;
			try {
				if (automatic) {
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
					modeSwitch.busy = false;
					renderMode();
					if (hadFocus) modeSwitch.focus();
				}
			}
		}));
		if (isAutomatic) modeSwitch.focus();
	}

	private registerAccessibility(content: HTMLElement, session: DisposableStore, pickerId: number): void {
		const ownerDocument = content.ownerDocument;
		content.setAttribute('role', 'dialog');
		content.setAttribute('aria-label', localize('chat.modelPicker.aria', 'Choose a chat model'));
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
								return localize('chat.modelPicker.help', 'Model menu. Space toggles Auto. When Auto is on, only its switch is shown. When Auto is off, Retirement badges show confirmed shutdown dates when available. Type to search, use Up and Down Arrow to browse models, and Enter to select. Right Arrow opens model settings. Tab moves between model settings. Space selects one acceleration option, turns it off, or turns long context on or off. Long context is off by default. Only one acceleration option can be selected. The model settings description explains how acceleration affects processing and usage. Use the model options button beside the model button to change thinking level or context size. Alt+Left Arrow returns to search. Escape closes the menu.');
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
	}
}
