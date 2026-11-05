import { Disposable, DisposableStore, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../../../base/common/layout.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
import { TabbedActionListWidget } from '../../../../../../../platform/actionWidget/browser/tabbedActionListWidget.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortOptions } from './modelPickerModelConfig.js';

/** Presents model selection above the trigger next to the effort control in Chat. */
export class ChatModelSliderWidget extends Disposable {
	private readonly panel: TabbedActionListWidget;

	constructor(
		private readonly delegate: IModelPickerDelegate,
		@IInstantiationService instantiationService: IInstantiationService,
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

	private effortChoices(model: ModelCatalogEntry | undefined) {
		if (!model) return [];
		if (model.presets?.length) {
			const selected = this.delegate.getSelectedPreset?.();
			return model.presets.map((preset, index, presets) => ({
				label: preset.label, selected: preset.id === selected, recommended: index === (presets.length >= 5 ? 1 : 0),
				select: () => this.delegate.selectPreset?.(preset.id),
			}));
		}
		return modelPickerEffortOptions(model, this.delegate.getSelectedReasoningEffort()).map(option => ({
			label: option.label, selected: option.checked, recommended: option.effort === model.defaultReasoningEffort,
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
			focus: container => {
				const search = container.querySelector<HTMLInputElement>('.ash-chat-slider-model-drawer:not([hidden]) input');
				(search ?? container.querySelector<HTMLButtonElement>('.ash-chat-slider-model-button'))?.focus();
			},
		});
	}

	private renderContent(container: HTMLElement, layout: () => void): IDisposable {
		const lifetime = new DisposableStore();
		const rendered = lifetime.add(new DisposableStore());
		const document = container.ownerDocument;
		const root = h(document, 'div', { className: 'ash-chat-model-slider-widget' });
		container.append(root);

		const models = this.delegate.getModels();
		const selectedModelRef = this.delegate.getSelectedModel();
		const currentModel = models.find(m => m.model.provider === selectedModelRef?.provider && m.model.model === selectedModelRef.model) ?? models[0];
		const hasMultiplePresets = !this.delegate.isAutomaticModel() && this.effortChoices(currentModel).length > 1;

		// Expand drawer by default only if there are no effort presets to adjust
		let isDrawerExpanded = !hasMultiplePresets;
		let searchQuery = '';

		const render = (focus?: 'search' | 'model' | 'effort') => {
			if (lifetime.isDisposed) {
				return;
			}
			rendered.clear();
			root.replaceChildren();

			const currentModels = this.delegate.getModels();
			const activeSelectedRef = this.delegate.getSelectedModel();
			const automatic = this.delegate.isAutomaticModel();
			const activeModel = automatic ? undefined : currentModels.find(m => m.model.provider === activeSelectedRef?.provider && m.model.model === activeSelectedRef.model) ?? currentModels[0];
			const presets = this.effortChoices(activeModel);
			const activePreset = presets.find(p => p.selected) ?? presets[0];
			const activeIndex = presets.indexOf(activePreset);

			// 1. Upward Drawer (Base model selector with search)
			const drawer = h(document, 'div', {
				className: 'ash-chat-slider-model-drawer',
				attributes: { role: 'menu', 'aria-label': localize('chat.modelPicker.models', 'Models') },
			});
			drawer.hidden = !isDrawerExpanded;

			// Search input
			const searchWrapper = h(document, 'div', { className: 'ash-chat-slider-search-wrap' });
			const searchInput = h(document, 'input', {
				className: 'ash-chat-slider-search-input',
				attributes: {
					role: 'combobox',
					type: 'text',
					placeholder: localize('chat.modelPicker.search', 'Search models'),
					'aria-label': localize('chat.modelPicker.search', 'Search models'),
					'aria-expanded': 'false',
				},
			});
			searchInput.value = searchQuery;
			rendered.add(addDisposableListener(searchInput, 'input', () => {
				searchQuery = searchInput.value.toLowerCase().trim();
				renderModelRows();
			}));
			searchWrapper.append(searchInput);
			drawer.append(searchWrapper);

			const modelListContainer = h(document, 'div', { className: 'ash-chat-slider-drawer-list' });
			const rows = rendered.add(new DisposableStore());
			const renderModelRows = () => {
				rows.clear();
				modelListContainer.replaceChildren();
				const entries = this.delegate.useWorkbenchModelManagement !== false && this.delegate.selectAutomaticModel ? [undefined, ...currentModels] : currentModels;
				for (const entry of entries) {
					const label = entry?.displayName ?? localize('chat.modelPicker.auto', 'Auto');
					if (searchQuery && !label.toLowerCase().includes(searchQuery)) continue;
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
					rows.add(addDisposableListener(row, 'click', selectModel));

					rows.add(addDisposableListener(row, 'keydown', event => {
						if (event.key === 'Enter' || event.key === ' ') {
							stopEvent(event);
							void selectModel();
						}
					}));

					modelListContainer.append(row);
				}
			};
			renderModelRows();
			drawer.append(modelListContainer);
			root.append(drawer);

			const modelTitle = automatic ? localize('chat.modelPicker.auto', 'Auto') : activeModel?.displayName ?? localize('chat.modelPicker.selectModel', 'Select model');
			const modelSummary = activePreset && presets.length > 1 ? `${modelTitle} · ${activePreset.label}` : modelTitle;
			const modelButton = h(document, 'button', {
				className: 'ash-chat-slider-model-button',
				attributes: {
					type: 'button',
					title: modelSummary,
					'aria-haspopup': 'menu',
					'aria-expanded': String(isDrawerExpanded),
				},
			});

			const modelLabel = h(document, 'span', { className: 'ash-chat-slider-model-title' });
			modelLabel.textContent = modelSummary;
			const chevron = h(document, 'span', { className: 'ash-chat-slider-chevron', attributes: { 'aria-hidden': 'true' } });
			appendIcon(Lxicon.dropDownButton, chevron);

			modelButton.append(modelLabel, chevron);
			rendered.add(addDisposableListener(modelButton, 'click', () => {
				isDrawerExpanded = !isDrawerExpanded;
				render(isDrawerExpanded ? 'search' : 'model');
			}));

			// 3. Effort Slider Card (Only when model has > 1 presets)
			let track: HTMLElement | undefined;
			if (presets.length > 1) {
				const effortCard = h(document, 'div', { className: 'ash-chat-slider-effort-card' });

				// Faster <---> Smarter row
				const speedRow = h(document, 'div', { className: 'ash-chat-slider-speed-row' });
				const faster = h(document, 'span', { className: 'ash-chat-slider-speed-label' });
				faster.textContent = localize('chat.modelPicker.faster', 'Faster');
				const smarter = h(document, 'span', { className: 'ash-chat-slider-speed-label' });
				smarter.textContent = localize('chat.modelPicker.smarter', 'Smarter');
				speedRow.append(faster, modelButton, smarter);
				effortCard.append(speedRow);

				// Slider track wrap
				const trackWrap = h(document, 'div', { className: 'ash-chat-slider-track-wrap' });
				const slider = h(document, 'div', {
					className: 'ash-chat-slider-track',
					attributes: {
						role: 'slider',
						tabindex: '0',
						'aria-label': localize('chat.modelPicker.thinkingEffort', 'Effort'),
						'aria-valuemin': '0',
						'aria-valuemax': String(presets.length - 1),
						'aria-valuenow': String(Math.max(0, activeIndex)),
						'aria-valuetext': activePreset?.label ?? '',
					},
				});
				track = slider;

				let recommendedPct: number | undefined;

				// Render ticks
				presets.forEach((p, idx) => {
					const pct = presets.length === 1 ? 50 : Math.round(6 + (idx / (presets.length - 1)) * 88);
					const isRec = p.recommended;
					if (isRec) recommendedPct = pct;

					const tick = h(document, 'button', {
						className: `ash-chat-slider-tick${isRec ? ' recommended-tick' : ''}`,
						attributes: {
							type: 'button',
							'aria-label': p.label,
							title: p.label,
						},
					});
					tick.style.left = `${pct}%`;

					rendered.add(addDisposableListener(tick, 'click', async e => {
						stopEvent(e);
						await p.select();
						render('effort');
					}));

					slider.append(tick);
				});

				// Thumb
				const thumbPct = activeIndex >= 0 && presets.length > 1
					? Math.round(6 + (activeIndex / (presets.length - 1)) * 88)
					: 6;
				const thumb = h(document, 'div', { className: 'ash-chat-slider-thumb' });
				thumb.style.left = `${thumbPct}%`;
				slider.append(thumb);

				// Track click handler
				rendered.add(addDisposableListener(slider, 'click', async (e: MouseEvent) => {
					const rect = slider.getBoundingClientRect();
					const clickX = e.clientX - rect.left;
					const clickPct = (clickX / rect.width) * 100;

					let closestIdx = 0;
					let minDiff = 999;
					presets.forEach((_, idx) => {
						const pct = Math.round(6 + (idx / (presets.length - 1)) * 88);
						const diff = Math.abs(pct - clickPct);
						if (diff < minDiff) {
							minDiff = diff;
							closestIdx = idx;
						}
					});

					const targetPreset = presets[closestIdx];
					if (targetPreset && targetPreset !== activePreset) {
						await targetPreset.select();
						render('effort');
					}
				}));

				// Keyboard navigation on track
				rendered.add(addDisposableListener(slider, 'keydown', async event => {
					if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
						stopEvent(event);
						if (activeIndex > 0) {
							await presets[activeIndex - 1]!.select();
							render('effort');
						}
					} else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
						stopEvent(event);
						if (activeIndex < presets.length - 1) {
							await presets[activeIndex + 1]!.select();
							render('effort');
						}
					}
				}));

				trackWrap.append(slider);

				// Recommended text annotation below
				if (recommendedPct !== undefined) {
					const recAnnotation = h(document, 'div', { className: 'ash-chat-slider-recommended' });
					recAnnotation.textContent = localize('chat.modelPicker.recommended', 'Recommended');
					recAnnotation.style.left = `${recommendedPct}%`;
					trackWrap.append(recAnnotation);
				}

				effortCard.append(trackWrap);
				root.append(effortCard);
			} else {
				root.append(modelButton);
			}
			if (container.isConnected) {
				layout();
			}
			if (focus) {
				const targets = { search: searchInput, model: modelButton, effort: track };
				targets[focus]?.focus({ preventScroll: true });
			}
		};

		render();
		return lifetime;
	}
}
