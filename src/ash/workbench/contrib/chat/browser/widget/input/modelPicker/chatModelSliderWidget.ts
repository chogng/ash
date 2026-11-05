import { Disposable, DisposableStore, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../../../base/common/layout.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../../../base/browser/ui/actionbar/actionbar.js';
import type { Icon } from '../../../../../../../base/common/icon.js';
import { localize } from '../../../../../../../nls.js';
import { TabbedActionListWidget } from '../../../../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { ILanguageModelsService } from '../../../../common/languageModels.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
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

	public show(anchor: HTMLElement): void {
		this.panel.showContent({
			anchor,
			anchorAlignment: AnchorAlignment.Center,
			anchorPosition: AnchorPosition.Above,
			width: 250,
			ariaLabel: localize('chat.modelPicker.aria', 'Choose a chat model'),
			render: (container, layout) => this.renderContent(container, layout),
			focus: container => this.focusModelPicker(container),
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
		const selected = this.delegate.getSelectedModel();
		const entry = selected && this.delegate.getModels().find(candidate =>
			candidate.model.provider === selected.provider && candidate.model.model === selected.model);
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
		container.append(root);

		const models = this.delegate.getModels();
		const selectedModelRef = this.delegate.getSelectedModel();
		const currentModel = models.find(m => m.model.provider === selectedModelRef?.provider && m.model.model === selectedModelRef.model) ?? models[0];
		const hasMultiplePresets = !this.delegate.isAutomaticModel() && this.effortChoices(currentModel).length > 1;

		// Expand drawer by default only if there are no effort presets to adjust
		let isDrawerExpanded = !hasMultiplePresets;
		const render = (focus?: 'models' | 'model' | 'effort') => {
			if (lifetime.isDisposed) {
				return;
			}
			rendered.clear();
			root.replaceChildren();

			const currentModels = this.delegate.getModels();
			const activeSelectedRef = this.delegate.getSelectedModel();
			const automatic = this.delegate.isAutomaticModel();
			const activeModel = automatic ? undefined : currentModels.find(m => m.model.provider === activeSelectedRef?.provider && m.model.model === activeSelectedRef.model) ?? currentModels[0];
			const builtInModel = this.getSelectedBuiltInModel();
			let effortOverride = builtInModel?.reasoningEffortOverride;
			const presets = this.effortChoices(activeModel, effortOverride);
			let activeIndex = Math.max(0, presets.findIndex(p => p.selected));

			// 1. Upward Drawer (Base model selector)
			const drawer = h(document, 'div', {
				className: 'ash-chat-slider-model-drawer',
				attributes: { id: drawerId, role: 'menu', 'aria-label': localize('chat.modelPicker.models', 'Models') },
			});
			drawer.hidden = !isDrawerExpanded;

			const modelListContainer = h(document, 'div', { className: 'ash-chat-slider-drawer-list' });
			const entries = this.delegate.useWorkbenchModelManagement !== false && this.delegate.selectAutomaticModel ? [undefined, ...currentModels] : currentModels;
			for (const entry of entries) {
				const label = entry?.displayName ?? localize('chat.modelPicker.auto', 'Auto');
				const isSelected = entry ? entry === activeModel : automatic;
				const row = h(document, 'div', {
					className: `ash-chat-slider-model-option${isSelected ? ' active' : ''}`,
					attributes: {
						role: 'menuitemradio',
						'aria-label': label,
						'aria-checked': String(isSelected),
						tabindex: '0',
					},
				});

				const title = h(document, 'span', { className: 'ash-chat-slider-model-name' });
				title.textContent = label;
				row.append(title);

				if (isSelected) {
					const check = h(document, 'span', { className: 'ash-chat-slider-check' });
					appendIcon(Lxicon.menuSelection, check);
					row.append(check);
				}

				const selectModel = async () => {
					if (entry) await this.delegate.selectModel(entry.model);
					else await this.delegate.selectAutomaticModel?.();
					if (lifetime.isDisposed) {
						return;
					}
					if (this.effortChoices(entry).length <= 1) {
						this.hide();
					} else {
						isDrawerExpanded = false;
						render('model');
					}
				};
				rendered.add(addDisposableListener(row, 'click', selectModel));

				rendered.add(addDisposableListener(row, 'keydown', event => {
					if (event.key === 'Enter' || event.key === ' ') {
						stopEvent(event);
						void selectModel();
					}
				}));

				modelListContainer.append(row);
			}
			drawer.append(modelListContainer);
			root.append(drawer);

			const modelTitle = automatic ? localize('chat.modelPicker.auto', 'Auto') : activeModel?.displayName ?? localize('chat.modelPicker.selectModel', 'Select model');
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
			const showEffortLabel = () => {
				const preset = presets[activeIndex];
				effortLabel.textContent = preset?.label ?? '';
				effortLabel.hidden = !preset;
				if (preset) { modelButton.setAttribute('aria-describedby', effortLabelId); }
			};
			showEffortLabel();
			const summary = h(document, 'div', { className: 'ash-chat-slider-model-summary' });
			summary.append(modelButton, effortLabel);

			rendered.add(addDisposableListener(modelButton, 'click', () => {
				isDrawerExpanded = !isDrawerExpanded;
				render(isDrawerExpanded ? 'models' : 'model');
			}));

			const useWorkbenchModelManagement = this.delegate.useWorkbenchModelManagement !== false;
			const effortCard = h(document, 'div', { className: 'ash-chat-slider-effort-card' });
			if (presets.length > 1 || useWorkbenchModelManagement) {
				const speedRow = h(document, 'div', { className: 'ash-chat-slider-speed-row' });
				if (useWorkbenchModelManagement) { this.renderModelActions(speedRow, summary, modelButton, rendered); }
				else { speedRow.append(summary); }
				effortCard.append(speedRow);
				root.append(effortCard);
			} else {
				root.append(summary);
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
				const thumb = h(document, 'div', { className: 'ash-chat-slider-thumb' });
				const showEffort = (index: number) => {
					activeIndex = index;
					thumb.style.left = `${position(index)}%`;
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

				const selectEffort = async (index: number) => {
					if (this.savingModelPreference || this.delegate.canSelectModel?.() === false) { return; }
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
					if (slider.isConnected) { render('effort'); }
				};
				rendered.add(this.delegate.onDidChangePresentation(() => {
					const model = this.getSelectedBuiltInModel();
					if (!model || !activeModel || model.model.provider !== activeModel.model.provider || model.model.model !== activeModel.model.model) { return; }
					const selected = this.effortChoices(model, model.reasoningEffortOverride).find(preset => preset.selected);
					const index = Math.max(0, presets.findIndex(preset => preset.id === selected?.id));
					if (index !== activeIndex) {
						showEffort(index);
						showEffortLabel();
					}
					if (model.reasoningEffortOverride !== effortOverride) {
						effortOverride = model.reasoningEffortOverride;
						describeUltra();
					}
				}));

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
						void selectEffort(idx);
					}));

					slider.append(tick);
				});

				slider.append(thumb);

				// Track click handler
				rendered.add(addDisposableListener(slider, 'click', async (e: MouseEvent) => {
					const rect = slider.getBoundingClientRect();
					const clickX = e.clientX - rect.left;
					const clickPct = (clickX / rect.width) * 100;

					let closestIdx = 0;
					let minDiff = 999;
					presets.forEach((_, idx) => {
						const diff = Math.abs(position(idx) - clickPct);
						if (diff < minDiff) {
							minDiff = diff;
							closestIdx = idx;
						}
					});

					if (closestIdx !== activeIndex) {
						await selectEffort(closestIdx);
					}
				}));

				// Keyboard navigation on track
				rendered.add(addDisposableListener(slider, 'keydown', async event => {
					if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
						stopEvent(event);
						if (activeIndex > 0) {
							await selectEffort(activeIndex - 1);
						}
					} else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
						stopEvent(event);
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
			} else if (focus) {
				const targets = { model: modelButton, effort: track };
				targets[focus]?.focus({ preventScroll: true });
			}
		};

		render();
		return lifetime;
	}
}
