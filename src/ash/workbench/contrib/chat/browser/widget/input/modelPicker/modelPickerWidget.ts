import { bindActionWidgetActivation } from '../../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import './media/modelPicker.css';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { renderModelConfigurationButton } from './modelPickerConfiguration.js';
import { getModelConfigEffortLabel, modelPickerEffortOptions } from './modelPickerModelConfig.js';
import { TabbedModelPicker } from './modelPickerTabbedWidget.js';
import { ChatModelSliderWidget } from './chatModelSliderWidget.js';
import { renderChatInputPickerSplit, trackChatInputPickerFocus } from '../chatInputPickerActionItem.js';

/** Toolbar controls project the delegate and choose a presentation for the model picker panel. */
export class ModelPickerWidget extends Disposable {
	private readonly hoverGroupId = createUuid();
	private nameButton: HTMLElement | undefined;
	private effortLabel: HTMLElement | undefined;
	private configurationButton: HTMLElement | undefined;
	private readonly nameHover = this._register(new MutableDisposable<IManagedHover>());
	private readonly configurationHover = this._register(new MutableDisposable<IManagedHover>());
	private actionEnabled = true;
	private picker: TabbedModelPicker | undefined;
	private sliderPicker: ChatModelSliderWidget | undefined;

	constructor(
		private readonly delegate: IModelPickerDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
	) { super(); }

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
		appendIcon(Lxicon.model, name).classList.add('ash-chat-input-model-action-icon');
		if (this.delegate.configureInMenu || this.delegate.chatModelSlider) {
			const labelGroup = h(container.ownerDocument, 'span', { className: 'ash-chat-input-model-label' });
			this.effortLabel = h(container.ownerDocument, 'span', {
				className: 'ash-chat-input-picker-label ash-chat-input-model-effort',
			});
			labelGroup.append(name.querySelector('.ash-chat-input-picker-label')!, this.effortLabel);
			name.append(labelGroup);
		}
		options.classList.add('ash-chat-input-configuration-action');
		name.setAttribute('aria-haspopup', 'dialog');
		options.setAttribute('aria-haspopup', 'dialog');
		this._register(bindActionWidgetActivation(name, source => {
			name.focus();
			if (this.visible) { this.hide(); }
			else { this.show(name, undefined, source !== 'pointer'); }
		}, () => this.enabled));
		this._register(bindActionWidgetActivation(options, () => {
			this.hide();
			options.focus();
			this.show(options, this.delegate.getSelectedModel());
		}, () => this.enabled));
		this._register(addDisposableListener(control, 'keydown', event => {
			if (!this.enabled || event.isComposing) { return; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				stopEvent(event);
				if (event.target === name) { this.show(name); }
				else { this.show(options, this.delegate.getSelectedModel()); }
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

	public focus(): void {
		this.nameButton?.focus();
	}

	public setCompact(compact: boolean): void {
		this.nameButton?.classList.toggle('icon-only', compact);
	}

	public setEnabled(enabled: boolean): void {
		this.actionEnabled = enabled;
		this.updateAvailability();
	}

	private get enabled(): boolean { return this.actionEnabled && this.delegate.canSelectModel?.() !== false; }

	private updateAvailability(): void {
		const enabled = this.enabled;
		for (const button of [this.nameButton, this.configurationButton]) {
			if (!button) continue;
			button.setAttribute('aria-disabled', String(!enabled));
			button.tabIndex = enabled && !button.hidden ? 0 : -1;
		}
		if (!enabled) { this.hide(); }
	}

	private updateButtons(sliderOpen = this.sliderPicker?.isVisible === true): void {
		if (this.delegate.chatModelSlider) this.picker?.hide();
		else this.sliderPicker?.hide();
		const selected = this.delegate.getSelectedModel();
		const model = this.delegate.getSelectedModelEntry();
		const automatic = this.delegate.isAutomaticModel();
		const selectedEffort = this.delegate.getSelectedReasoningEffort();
		const selectedPresetId = this.delegate.getSelectedPreset?.();
		const selectedPreset = model?.presets?.find(p => p.id === selectedPresetId);
		const label = sliderOpen ? localize('chat.modelPicker.selectModel', 'Select model') : automatic
			? localize('chat.modelPicker.auto', 'Auto')
			: model?.displayName ?? selected?.model ?? localize('chat.modelPicker.selectModel', 'Select model');
		const showPreset = this.delegate.chatModelSlider && selectedPreset && (model?.presets?.length ?? 0) > 1;
		const displayedEffort = this.delegate.chatModelSlider && this.delegate.useWorkbenchModelManagement !== false
			? model?.reasoningEffortOverride ?? selectedEffort
			: selectedEffort;
		const effort = this.effortLabel && !sliderOpen && !automatic && model
			? (showPreset ? selectedPreset.label : getModelConfigEffortLabel(model, displayedEffort))
			: undefined;
		this.nameButton!.querySelector('.ash-chat-input-picker-label')!.textContent = label;
		if (this.effortLabel) {
			this.effortLabel.textContent = effort ?? '';
			this.effortLabel.hidden = !effort;
		}
		const buttonLabel = effort ? `${label} ${effort}` : label;
		this.nameButton!.setAttribute('aria-label', buttonLabel);
		this.nameHover.clear();
		this.nameHover.value = getHoverDelegate().setupHover({ target: this.nameButton!, content: buttonLabel, groupId: this.hoverGroupId });
		renderModelConfigurationButton(this.configurationButton!, model, selectedEffort, this.delegate.configureInMenu === true || automatic,
			this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration));
		this.configurationHover.clear();
		this.configurationHover.value = getHoverDelegate().setupHover({
			target: this.configurationButton!, content: this.configurationButton!.getAttribute('aria-label')!, groupId: this.hoverGroupId,
		});
		if (this.configurationButton!.hidden && this.configurationButton!.ownerDocument.activeElement === this.configurationButton) { this.focus(); }
		this.updateAvailability();
	}

	public get visible(): boolean { return (this.sliderPicker?.isVisible || this.picker?.isVisible) ?? false; }

	public hide(): void {
		this.sliderPicker?.hide();
		this.picker?.hide();
	}

	private reserveSliderWidth(): IDisposable {
		const button = this.nameButton!;
		const document = button.ownerDocument;
		const samples = h(document, 'span', {
			className: 'ash-chat-input-model-width-samples', attributes: { 'aria-hidden': 'true' },
		});
		for (const model of this.delegate.getModels()) {
			const efforts = (model.presets?.length ?? 0) > 1
				? model.presets!.map(preset => preset.label)
				: modelPickerEffortOptions(model, undefined).map(option => option.label);
			const defaultEffort = getModelConfigEffortLabel(model, undefined);
			if (defaultEffort && !efforts.includes(defaultEffort)) { efforts.push(defaultEffort); }
			for (const effort of efforts.length ? efforts : [undefined]) {
				const sample = h(document, 'span', { attributes: { 'data-model': model.displayName } });
				if (effort) { sample.setAttribute('data-effort', effort); }
				samples.append(sample);
			}
		}
		button.append(samples);
		return toDisposable(() => samples.remove());
	}

	public show(anchor: HTMLElement = this.nameButton!, detailsModel?: ModelRef, focusModelOnOpen = true): void {
		if (!this.enabled || this.visible) { return; }
		if (this.delegate.chatModelSlider) {
			this.sliderPicker ??= this._register(this.instantiationService.createInstance(ChatModelSliderWidget, this.delegate));
			const width = this.reserveSliderWidth();
			// Lay out the fixed trigger label before the popup reads its anchor bounds.
			this.updateButtons(true);
			this.sliderPicker.show(anchor, () => {
				width.dispose();
				if (!this.isDisposed) { this.updateButtons(); }
			}, focusModelOnOpen);
		} else {
			this.picker ??= this._register(this.instantiationService.createInstance(TabbedModelPicker, this.delegate));
			this.picker.show(anchor, detailsModel, this.delegate.configureInMenu === true);
		}
	}
}
