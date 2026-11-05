import { bindActionWidgetActivation } from '../../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import './media/modelPicker.css';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { renderModelConfigurationButton } from './modelPickerConfiguration.js';
import { getModelConfigEffortLabel } from './modelPickerModelConfig.js';
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
		if (this.delegate.configureInMenu) {
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
		this._register(bindActionWidgetActivation(name, () => {
			name.focus();
			if (this.visible) { this.hide(); }
			else { this.show(name); }
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

	private updateButtons(): void {
		if (this.delegate.chatModelSlider) this.picker?.hide();
		else this.sliderPicker?.hide();
		const selected = this.delegate.getSelectedModel();
		const model = this.delegate.getModels().find(entry => entry.model.provider === selected?.provider && entry.model.model === selected.model);
		const automatic = this.delegate.isAutomaticModel();
		const selectedEffort = this.delegate.getSelectedReasoningEffort();
		const selectedPresetId = this.delegate.getSelectedPreset?.();
		const selectedPreset = model?.presets?.find(p => p.id === selectedPresetId);
		let label = automatic
			? localize('chat.modelPicker.auto', 'Auto')
			: model?.displayName ?? selected?.model ?? localize('chat.modelPicker.selectModel', 'Select model');
		if (this.delegate.chatModelSlider && selectedPreset && (model?.presets?.length ?? 0) > 1) {
			label = `${label} · ${selectedPreset.label}`;
		}
		const displayedEffort = this.delegate.chatModelSlider && this.delegate.useWorkbenchModelManagement !== false
			? model?.reasoningEffortOverride ?? selectedEffort
			: selectedEffort;
		let effort = this.effortLabel && !automatic && model
			? getModelConfigEffortLabel(model, displayedEffort)
			: undefined;
		if (this.delegate.chatModelSlider && effort) {
			label = `${label} · ${effort}`;
			effort = undefined;
		}
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

	public show(anchor: HTMLElement = this.nameButton!, detailsModel?: ModelRef): void {
		if (!this.enabled || this.visible) { return; }
		if (this.delegate.chatModelSlider) {
			this.sliderPicker ??= this._register(this.instantiationService.createInstance(ChatModelSliderWidget, this.delegate));
			this.sliderPicker.show(anchor);
		} else {
			this.picker ??= this._register(this.instantiationService.createInstance(TabbedModelPicker, this.delegate));
			this.picker.show(anchor, detailsModel, this.delegate.configureInMenu === true);
		}
	}
}
