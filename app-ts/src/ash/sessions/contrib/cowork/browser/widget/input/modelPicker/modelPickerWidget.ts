import './modelPicker.css';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IActionWidgetService } from '../../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { ModelCatalogEntry } from '../../../../../../../workbench/services/chat/common/modelCatalog.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import { ModelPickerDetailsMenu } from './modelPickerHover.js';
import { buildModelPickerItems } from './modelPickerItems.js';

let nextPickerId = 0;

/** Model controls retain business state; ActionWidget owns the popup and its action list. */
export class ModelPickerWidget extends Disposable {
	private readonly popup: MutableDisposable<DisposableStore>;

	constructor(private readonly delegate: IModelPickerDelegate, @IActionWidgetService private readonly actionWidgetService: IActionWidgetService, @IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService, @ILanguageModelsService private readonly languageModels: ILanguageModelsService) {
		super();
		// Close the service-owned popup before releasing the controls attached to it.
		this._register(toDisposable(() => this.hide()));
		this.popup = this._register(new MutableDisposable<DisposableStore>());
	}

	public get visible(): boolean {
		return this.popup.value !== undefined;
	}

	public hide(): void {
		if (this.visible) {
			this.actionWidgetService.hide();
		}
	}

	public show(anchor: HTMLElement): void {
		if (this.visible) return;
		const ownerDocument = anchor.ownerDocument;
		let models = this.delegate.getModels();
		const session = new DisposableStore();
		const pickerId = ++nextPickerId;
		const header = h(ownerDocument, 'div');
		const footer = h(ownerDocument, 'div');
		footer.className = 'ash-cowork-model-picker-footer';
		const error = h(ownerDocument, 'div');
		error.className = 'ash-cowork-model-picker-error';
		error.setAttribute('role', 'status');
		error.hidden = true;
		let autoSwitch: Switch | undefined;
		if (models.length === 0) {
			header.className = 'ash-cowork-model-picker-empty';
			const message = h(ownerDocument, 'div');
			message.className = 'ash-cowork-model-picker-empty-message';
			message.setAttribute('role', 'status');
			message.textContent = this.delegate.getModelsError()
				? localize('chat.modelPicker.loadFailed', 'Could not load models')
				: localize('chat.modelPicker.noModels', 'No models available');
			const guidance = h(ownerDocument, 'div');
			guidance.className = 'ash-cowork-model-picker-empty-guidance';
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
			header.className = 'ash-cowork-model-picker-auto';
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
		this.actionWidgetService.show(`coworkModelPicker-${pickerId}`, false, isAutomatic ? [] : buildModelPickerItems(models, this.delegate.getSelectedModel()), {
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
			className: 'ash-cowork-model-picker',
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
				name: `coworkModelPicker-${pickerId}`,
				getProvider: () => {
					const active = ownerDocument.activeElement;
					if (!(active instanceof HTMLElement) || !content.contains(active)) { return undefined; }
					return new AccessibleContentProvider(
						AccessibleViewProviderId.ChatModelConfiguration,
						{ type },
						() => {
							if (type === AccessibleViewType.Help) {
								return localize('chat.modelPicker.help', 'Model menu. Space toggles Auto. When Auto is on, only its switch is shown. When Auto is off, type to search, use Up and Down Arrow to browse models, and Enter to select. Right Arrow opens model settings. Space toggles Fast or the context window when supported. The model settings description explains how acceleration affects processing and usage. Use the thinking effort menu beside the model button to change thinking level. Alt+Left Arrow returns to search. Escape closes the menu.');
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
