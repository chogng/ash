import { Disposable, DisposableStore, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Separator, type IAction } from '../../../../../../../base/common/actions.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../../../base/common/layout.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { clamp } from '../../../../../../../base/common/numbers.js';
import { toErrorMessage } from '../../../../../../../base/common/errorMessage.js';
import { addDisposableListener, getWindow, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { GlobalPointerMoveMonitor } from '../../../../../../../base/browser/globalPointerMoveMonitor.js';
import { ActionBar } from '../../../../../../../base/browser/ui/actionbar/actionbar.js';
import { Menu } from '../../../../../../../base/browser/ui/menu/menu.js';
import type { Icon } from '../../../../../../../base/common/icon.js';
import { localize } from '../../../../../../../nls.js';
import { TabbedActionListWidget } from '../../../../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultMenuStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { modelRefIdentity, type ModelCatalogEntry, type ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortOptions } from './modelPickerModelConfig.js';
import type { ModelPreferencesUpdate } from '../../../../../../../platform/models/common/agentModels.js';

/** Presents model selection above the trigger next to the effort control in Chat. */
export class ChatModelSliderWidget extends Disposable {
	private readonly panel: TabbedActionListWidget;
	private savingModelPreference = false;

	constructor(
		private readonly delegate: IModelPickerDelegate,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.panel = this._register(instantiationService.createInstance(TabbedActionListWidget));
	}

	public get isVisible(): boolean {
		return this.panel.isVisible;
	}

	public hide(): void {
		this.panel.hide();
	}

	private effortChoices(model: ModelCatalogEntry | undefined, override?: ModelReasoningEffort) {
		if (!model) return [];
		if (model.presets?.length) {
			const selected = this.delegate.getSelectedPreset?.();
			return model.presets.map(preset => ({
				id: preset.id,
				label: preset.label, selected: preset.id === selected,
				select: () => this.delegate.selectPreset?.(preset.id),
			}));
		}
		return modelPickerEffortOptions(model, override ?? this.delegate.getSelectedReasoningEffort()).map(option => ({
			id: option.effort,
			label: option.label, selected: option.checked,
			select: () => this.delegate.selectReasoningEffort(option.effort),
		}));
	}

	public show(anchor: HTMLElement, onClose?: () => void, focusModelOnOpen = true): void {
		this.panel.showContent({
			anchor,
			anchorAlignment: AnchorAlignment.Center,
			anchorPosition: AnchorPosition.Above,
			width: 250,
			ariaLabel: localize('chat.modelPicker.aria', 'Choose a chat model'),
			render: (container, layout) => this.renderContent(container, layout),
			focus: container => {
				if (focusModelOnOpen) {
					this.focusModelPicker(container);
				} else {
					// Keep Tab and Escape in the dialog without focusing a model on pointer open.
					container.tabIndex = -1;
					container.focus({ preventScroll: true });
				}
			},
			onClose,
		});
	}

	private focusModelPicker(container: HTMLElement): void {
		const drawer = container.querySelector('.ash-chat-slider-model-drawer:not([hidden])');
		const target = drawer?.querySelector<HTMLElement>('[aria-checked="true"]')
			?? drawer?.querySelector<HTMLElement>('[role="menuitemradio"]')
			?? container.querySelector<HTMLButtonElement>('.ash-chat-slider-model-button');
		target?.focus();
	}

	private getSelectedBuiltInModel(): ModelCatalogEntry | undefined {
		if (this.delegate.useWorkbenchModelManagement === false || this.delegate.isAutomaticModel()) { return undefined; }
		const entry = this.delegate.getSelectedModelEntry();
		const provider = entry?.source?.providerId;
		// The native catalog also includes custom endpoints and discovered external models.
		if (!provider || provider.startsWith('custom-') || provider === 'openai-compatible' || entry?.discovered) { return undefined; }
		return entry;
	}

	private async updateModelPreference(change: (model: ModelCatalogEntry) => ModelPreferencesUpdate | undefined): Promise<boolean> {
		if (this.savingModelPreference || this.delegate.canSelectModel?.() === false) { return false; }
		const model = this.getSelectedBuiltInModel();
		const update = model && change(model);
		if (!model || !update) { return false; }
		this.savingModelPreference = true;
		try {
			await this.languageModels.setModelPreferences(model.model, update);
			return true;
		} catch {
			if (!this.isDisposed) { this.notifications.error(localize('chat.modelPicker.configurationFailed', 'Could not update model settings')); }
			return false;
		} finally {
			this.savingModelPreference = false;
		}
	}

	private renderModelActions(row: HTMLElement, summary: HTMLElement, modelButton: HTMLButtonElement, rendered: DisposableStore): void {
		const addToggle = (
			id: string, label: string, icon: Icon, activeIcon: Icon,
			readChecked: (model: ModelCatalogEntry) => boolean | undefined, run: () => Promise<boolean>,
		): void => {
			const bar = rendered.add(new ActionBar(row, {
				ariaLabel: label,
				highlightToggledItems: true,
				actionViewItemOptions: { buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet', iconOnly: true },
			}));
			bar.domNode.hidden = true;
			let checked: boolean | undefined;
			const refresh = () => {
				const model = this.getSelectedBuiltInModel();
				const value = model && readChecked(model);
				if (value === checked) { return; }
				checked = value;
				if (value === undefined && bar.domNode.contains(row.ownerDocument.activeElement)) {
					modelButton.focus({ preventScroll: true });
				}
				bar.domNode.hidden = value === undefined;
				bar.setActions(value === undefined ? [] : [{
					id, label, tooltip: label, enabled: true, checked: value, icon: value ? activeIcon : icon, run,
				}]);
			};
			refresh();
			rendered.add(this.delegate.onDidChangePresentation(refresh));
		};
		addToggle('chat.modelPicker.fastMode', localize('chat.modelPicker.fastMode', 'Fast Mode'), Lxicon.lightning, Lxicon.lightningFilled,
			model => {
				const fast = model.accelerationOptions?.find(option => option.name === 'Fast');
				return fast && model.selectedAcceleration === fast.id;
			}, () => this.updateModelPreference(model => {
				const fast = model.accelerationOptions?.find(option => option.name === 'Fast');
				return fast && { acceleration: model.selectedAcceleration === fast.id ? null : fast.id };
			}));
		row.append(summary);
		addToggle('chat.modelPicker.ultraMode', localize('chat.modelPicker.ultraMode', 'Ultra Mode'), Lxicon.brain, Lxicon.brain,
			model => model.ultra, () => this.updateModelPreference(model => model.ultra === undefined ? undefined : { ultra: !model.ultra }));
	}

	private renderContent(container: HTMLElement, layout: () => void): IDisposable {
		const lifetime = new DisposableStore();
		const rendered = lifetime.add(new DisposableStore());
		const document = container.ownerDocument;
		const root = h(document, 'div', { className: 'ash-chat-model-slider-widget' });
		const drawerId = `ash-chat-slider-models-${createUuid()}`;
		const effortLabelId = `${drawerId}-effort`;
		container.classList.add('ash-chat-model-slider-dialog');
		container.append(root);

		const models = this.delegate.getModels();
		let displayedModels = models;
		const selectedModelRef = this.delegate.getSelectedModel();
		const currentModel = models.find(m => m.model.provider === selectedModelRef?.provider && m.model.model === selectedModelRef.model);
		const hasMultiplePresets = !this.delegate.isAutomaticModel() && this.effortChoices(currentModel).length > 1;

		// Expand drawer by default only if there are no effort presets to adjust
		let isDrawerExpanded = !hasMultiplePresets;
		const render = (focus?: 'models' | 'menu' | 'model' | 'effort') => {
			if (lifetime.isDisposed) {
				return;
			}
			rendered.clear();
			root.replaceChildren();

			const currentModels = this.delegate.getModels();
			displayedModels = currentModels;
			const activeSelectedRef = this.delegate.getSelectedModel();
			const automatic = this.delegate.isAutomaticModel();
			const activeModel = automatic ? undefined : this.delegate.getSelectedModelEntry();
			const builtInModel = this.getSelectedBuiltInModel();
			let effortOverride = builtInModel?.reasoningEffortOverride;
			const presets = this.effortChoices(activeModel, effortOverride);
			let activeIndex = Math.max(0, presets.findIndex(p => p.selected));

			const drawer = h(document, 'div', {
				className: 'ash-chat-slider-model-drawer',
				attributes: { id: drawerId },
			});
			drawer.hidden = !isDrawerExpanded;

			const entries = this.delegate.useWorkbenchModelManagement !== false && this.delegate.selectAutomaticModel ? [undefined, ...currentModels] : currentModels;
			const actions: IAction[] = entries.map(entry => ({
				id: entry ? modelRefIdentity(entry.model) : 'chat.modelPicker.auto',
				label: entry?.displayName ?? localize('chat.modelPicker.auto', 'Auto'),
				tooltip: '',
				checked: entry ? entry === activeModel : automatic,
				enabled: true,
				run: async () => {
					try {
						if (entry) await this.delegate.selectModel(entry.model);
						else await this.delegate.selectAutomaticModel?.();
					} catch (error) {
						if (!lifetime.isDisposed) this.notifications.error(toErrorMessage(error));
						return;
					}
					if (lifetime.isDisposed) {
						return;
					}
					if (this.effortChoices(entry).length <= 1) {
						this.hide();
					} else {
						isDrawerExpanded = false;
						render('model');
					}
				},
			}));
			if (actions.length) { actions.push(new Separator()); }
			const menu = rendered.add(new Menu(drawer, actions, {
				ariaLabel: localize('chat.modelPicker.models', 'Models'),
				buttonStyles: defaultButtonStyles,
				className: 'ash-chat-slider-model-menu',
				iconPlacement: 'trailing',
				getCheckedActionsRepresentation: () => 'radio',
			}, defaultMenuStyles));
			root.append(drawer);

			const modelTitle = automatic ? localize('chat.modelPicker.auto', 'Auto') : activeModel?.displayName ?? activeSelectedRef?.model ?? localize('chat.modelPicker.selectModel', 'Select model');
			const modelButton = h(document, 'button', {
				className: 'ash-chat-slider-model-button',
				attributes: {
					type: 'button',
					title: modelTitle,
					'aria-haspopup': 'menu',
					'aria-expanded': String(isDrawerExpanded),
					'aria-controls': drawerId,
				},
			});

			const modelLabel = h(document, 'span', { className: 'ash-chat-slider-model-title' });
			modelLabel.textContent = modelTitle;
			modelButton.append(modelLabel);
			const effortLabel = h(document, 'span', { className: 'ash-chat-slider-effort-label', attributes: { id: effortLabelId } });
			const showEffortLabel = (index: number) => {
				const label = presets[index]?.label ?? '';
				if (effortLabel.textContent !== label) { effortLabel.textContent = label; }
			};
			effortLabel.hidden = !presets.length;
			if (presets.length) { modelButton.setAttribute('aria-describedby', effortLabelId); }
			showEffortLabel(activeIndex);
			const summary = h(document, 'div', { className: 'ash-chat-slider-model-summary' });
			summary.append(modelButton, effortLabel);

			rendered.add(addDisposableListener(modelButton, 'click', event => {
				isDrawerExpanded = !isDrawerExpanded;
				render(isDrawerExpanded ? (event.detail === 0 ? 'models' : 'menu') : 'model');
			}));

			const useWorkbenchModelManagement = this.delegate.useWorkbenchModelManagement !== false;
			const effortCard = h(document, 'div', { className: 'ash-chat-slider-effort-card' });
			root.append(effortCard);
			if (presets.length > 1 || useWorkbenchModelManagement) {
				const speedRow = h(document, 'div', { className: 'ash-chat-slider-speed-row' });
				if (useWorkbenchModelManagement) { this.renderModelActions(speedRow, summary, modelButton, rendered); }
				else { speedRow.append(summary); }
				effortCard.append(speedRow);
			} else {
				effortCard.append(summary);
			}

			let track: HTMLElement | undefined;
			if (presets.length > 1) {
				const slider = h(document, 'div', {
					className: 'ash-chat-slider-track',
					attributes: {
						role: 'slider',
						tabindex: '0',
						'aria-label': localize('chat.modelPicker.thinkingEffort', 'Effort'),
						'aria-valuemin': '0',
						'aria-valuemax': String(presets.length - 1),
					},
				});
				track = slider;

				const position = (index: number) => Math.round(6 + index / (presets.length - 1) * 88);
				const fill = h(document, 'div', { className: 'ash-chat-slider-fill', attributes: { 'aria-hidden': 'true' } });
				const thumb = h(document, 'div', { className: 'ash-chat-slider-thumb', attributes: { 'aria-hidden': 'true' } });
				slider.append(fill);
				const drag = rendered.add(new GlobalPointerMoveMonitor());
				const showPosition = (percent: number, previewIndex = activeIndex) => {
					const offset = `${percent}%`;
					if (thumb.style.left !== offset) {
						fill.style.width = offset;
						thumb.style.left = offset;
					}
					showEffortLabel(previewIndex);
				};
				const showEffort = (index: number) => {
					activeIndex = index;
					if (!drag.isMonitoring()) { showPosition(position(index)); }
					slider.setAttribute('aria-valuenow', String(index));
					slider.setAttribute('aria-valuetext', presets[index].label);
				};
				const describeUltra = () => {
					if (effortOverride === undefined) {
						slider.removeAttribute('aria-description');
						slider.removeAttribute('title');
						return;
					}
					const description = localize('chat.modelPicker.ultraSliderDescription', 'Ultra uses {0}. Changing the effort turns off Ultra.', presets[activeIndex].label);
					slider.setAttribute('aria-description', description);
					slider.title = description;
				};
				showEffort(activeIndex);
				describeUltra();

				const refreshEffort = () => {
					const model = this.delegate.getSelectedModelEntry();
					if (!model || !activeModel || model.model.provider !== activeModel.model.provider || model.model.model !== activeModel.model.model) { return; }
					const override = this.getSelectedBuiltInModel()?.reasoningEffortOverride;
					const selected = this.effortChoices(model, override).find(preset => preset.selected);
					const index = Math.max(0, presets.findIndex(preset => preset.id === selected?.id));
					if (index !== activeIndex) {
						showEffort(index);
					}
					if (override !== effortOverride) {
						effortOverride = override;
						describeUltra();
					}
				};
				rendered.add(this.delegate.onDidChangePresentation(refreshEffort));

				const selectEffort = async (index: number) => {
					if (drag.isMonitoring() || this.savingModelPreference || this.delegate.canSelectModel?.() === false) { return; }
					const model = this.getSelectedBuiltInModel();
					if (model?.reasoningEffortOverride !== undefined) {
						if (index === activeIndex) { return; }
						const inputLifecycle = this.delegate.getInputLifecycle?.();
						if (!await this.updateModelPreference(() => ({ ultra: false }))) { return; }
						const selected = this.delegate.getSelectedModel();
						if (this.isDisposed || inputLifecycle?.aborted || this.delegate.isAutomaticModel()
							|| selected?.provider !== model.model.provider || selected.model !== model.model.model) { return; }
					}
					await presets[index].select();
					if (slider.isConnected) {
						refreshEffort();
						slider.focus({ preventScroll: true });
					}
				};

				// Render ticks
				presets.forEach((p, idx) => {
					const pct = position(idx);

					const tick = h(document, 'button', {
						className: 'ash-chat-slider-tick',
						attributes: {
							type: 'button',
							'aria-label': p.label,
							title: p.label,
						},
					});
					tick.style.left = `${pct}%`;

					rendered.add(addDisposableListener(tick, 'click', e => {
						stopEvent(e);
						// Pointer activation commits at the end of the drag. Keep keyboard and AT clicks.
						if (e.detail === 0) {
							slider.classList.remove('track-press');
							void selectEffort(idx);
						}
					}));

					slider.append(tick);
				});

				slider.append(thumb);

				const closestEffort = (percent: number) => {
					let closestIdx = 0;
					let minDiff = Infinity;
					presets.forEach((_, idx) => {
						const diff = Math.abs(position(idx) - percent);
						if (diff < minDiff) {
							minDiff = diff;
							closestIdx = idx;
						}
					});

					return closestIdx;
				};
				rendered.add(addDisposableListener(slider, 'pointerdown', event => {
					if (event.button !== 0 || drag.isMonitoring() || this.savingModelPreference || this.delegate.canSelectModel?.() === false) { return; }
					layout();
					const rail = slider.getBoundingClientRect();
					if (!rail.width) { return; }
					event.preventDefault();
					const bounds = thumb.getBoundingClientRect();
					const onThumb = event.clientX >= bounds.left && event.clientX <= bounds.right
						&& event.clientY >= bounds.top && event.clientY <= bounds.bottom;
					const center = bounds.left + bounds.width / 2;
					const grabOffset = onThumb ? event.clientX - center : 0;
					const percentAt = (x: number) => clamp(
						(x - grabOffset - rail.left) / rail.width * 100,
						position(0), position(presets.length - 1),
					);
					const movedAlongTrack = (x: number) => Math.abs(x - event.clientX) >= 4;
					let preview = onThumb ? position(activeIndex) : percentAt(event.clientX);
					let followsPointer = onThumb;
					slider.classList.toggle('dragging', followsPointer);
					slider.classList.toggle('track-press', !followsPointer);
					const previewIndex = closestEffort(preview);
					showPosition(onThumb ? percentAt(event.clientX) : position(previewIndex), previewIndex);
					slider.focus({ preventScroll: true });
					const finish = async (index: number) => {
						slider.classList.remove('dragging');
						showPosition(position(index), index);
						try {
							if (index !== activeIndex) { await selectEffort(index); }
						} catch (error) {
							if (slider.isConnected) { this.notifications.error(toErrorMessage(error)); }
						} finally {
							if (!drag.isMonitoring() && slider.isConnected) { showPosition(position(activeIndex)); }
						}
					};
					const release = (clientX: number) => finish(closestEffort(
						clientX === event.clientX || (!followsPointer && !movedAlongTrack(clientX)) ? preview : percentAt(clientX),
					));
					drag.startMonitoring(thumb, event.pointerId, event.buttons, next => {
						if (!followsPointer) {
							if (!movedAlongTrack(next.clientX)) { return; }
							followsPointer = true;
							slider.classList.replace('track-press', 'dragging');
						}
						preview = percentAt(next.clientX);
						showPosition(preview, closestEffort(preview));
					}, next => {
						switch (next?.type) {
							case 'pointerup':
							case 'mouseup': void release((next as MouseEvent).clientX); break;
							case 'pointermove': void finish(closestEffort(preview)); break;
							default: void finish(activeIndex); break;
						}
					}, event.pointerType);
				}));
				rendered.add(addDisposableListener(getWindow(slider), 'resize', () => drag.stopMonitoring(true)));

				// Keyboard navigation on track
				rendered.add(addDisposableListener(slider, 'keydown', async event => {
					if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
						stopEvent(event);
						slider.classList.remove('track-press');
						if (activeIndex > 0) {
							await selectEffort(activeIndex - 1);
						}
					} else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
						stopEvent(event);
						slider.classList.remove('track-press');
						if (activeIndex < presets.length - 1) {
							await selectEffort(activeIndex + 1);
						}
					}
				}));

				effortCard.append(slider);
			}
			if (container.isConnected) {
				layout();
			}
			if (focus === 'models') {
				this.focusModelPicker(root);
			} else if (focus === 'menu') {
				menu.focus(false);
			} else if (focus) {
				const targets = { model: modelButton, effort: track };
				(targets[focus] ?? modelButton).focus({ preventScroll: true });
			}
		};

		render();
		lifetime.add(this.delegate.onDidChangePresentation(() => {
			const current = this.delegate.getModels();
			if (current.length === displayedModels.length && current.every((entry, index) => {
				const displayed = displayedModels[index]!;
				return modelRefIdentity(entry.model) === modelRefIdentity(displayed.model) && entry.displayName === displayed.displayName;
			})) return;
			const focused = document.activeElement;
			if (!root.contains(focused)) {
				render();
				return;
			}
			render(focused?.closest('[role="slider"]') ? 'effort' : 'models');
		}));
		return lifetime;
	}
}
