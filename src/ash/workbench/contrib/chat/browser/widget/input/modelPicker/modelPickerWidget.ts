import './media/modelPicker.css';
import { addDisposableListener, h, stopEvent } from '../../../../../../../base/browser/dom.js';
import { EventType, Gesture } from '../../../../../../../base/browser/touch.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { IModelPickerDelegate } from './modelPickerActionItem.js';
import { renderModelConfigurationButton } from './modelPickerConfiguration.js';
import { TabbedModelPicker } from './modelPickerTabbedWidget.js';
import { renderChatInputPickerSplit, trackChatInputPickerFocus } from '../chatInputPickerActionItem.js';

/** Toolbar controls project the delegate; TabbedModelPicker owns their shared popup interaction. */
export class ModelPickerWidget extends Disposable {
	private readonly hoverGroupId = createUuid();
	private nameButton: HTMLElement | undefined;
	private configurationButton: HTMLElement | undefined;
	private readonly nameHover = this._register(new MutableDisposable<IManagedHover>());
	private readonly configurationHover = this._register(new MutableDisposable<IManagedHover>());
	private enabled = true;
	private picker: TabbedModelPicker | undefined;

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
		options.classList.add('ash-chat-input-configuration-action');
		name.setAttribute('aria-haspopup', 'dialog');
		options.setAttribute('aria-haspopup', 'dialog');
		this.picker = this._register(this.instantiationService.createInstance(TabbedModelPicker, this.delegate));
		this.bindTrigger(name, () => {
			name.focus();
			if (this.visible) { this.hide(); }
			else { this.show(name); }
		});
		this.bindTrigger(options, () => {
			this.hide();
			options.focus();
			this.show(options, this.delegate.getSelectedModel());
		});
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
		for (const button of [this.nameButton, this.configurationButton]) {
			if (!button) continue;
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
			: model?.displayName ?? (selected ? `${selected.provider}/${selected.model}` : localize('chat.modelPicker.selectModel', 'Select model'));
		this.nameButton!.querySelector('.ash-chat-input-picker-label')!.textContent = label;
		this.nameButton!.setAttribute('aria-label', label);
		this.nameHover.clear();
		this.nameHover.value = getHoverDelegate().setupHover({ target: this.nameButton!, content: label, groupId: this.hoverGroupId });
		renderModelConfigurationButton(this.configurationButton!, model, this.delegate.getSelectedReasoningEffort(), this.delegate.isAutomaticModel(),
			this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration));
		this.configurationHover.clear();
		this.configurationHover.value = getHoverDelegate().setupHover({
			target: this.configurationButton!, content: this.configurationButton!.getAttribute('aria-label')!, groupId: this.hoverGroupId,
		});
		if (this.configurationButton!.hidden && this.configurationButton!.ownerDocument.activeElement === this.configurationButton) { this.focus(); }
		this.setEnabled(this.enabled);
	}

	public get visible(): boolean { return this.picker?.isVisible ?? false; }

	public hide(): void { this.picker?.hide(); }

	public show(anchor: HTMLElement = this.nameButton!, detailsModel?: ModelRef): void {
		if (!this.enabled || this.visible) { return; }
		this.picker?.show(anchor, detailsModel);
	}
}
