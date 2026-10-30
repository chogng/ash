import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import { DomWidget } from '../../../../../../../platform/domWidget/browser/domWidget.js';
import { IOpenerService } from '../../../../../../../platform/opener/common/opener.js';
import { IconLabel } from '../../../../../../../base/browser/ui/iconlabel/iconlabel.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { getModelConfigValueLabel, modelPickerEffortOptions, modelPickerAccelerationOptions } from './modelPickerModelConfig.js';
import { getMaxContextLabel, renderModelDescription } from './modelPickerDetails.js';
import { getModelProviderIcon } from './modelProviderIcons.js';

export interface IModelCardOptions {
	getSelectedReasoningEffort(): ModelReasoningEffort | undefined;
	onReasoningEffortChange(effort: ModelReasoningEffort | undefined): Promise<void>;
	onLongContextChange(longContext: boolean): Promise<void>;
	onAccelerationChange(acceleration: string | null): Promise<void>;
}

let nextCardId = 0;

/** Catalog information and supported settings; the caller owns selection and persistence. */
export class ModelCard extends DomWidget {
	public readonly domNode: HTMLElement;
	private readonly descriptionDomNode: HTMLElement;
	private readonly title: IconLabel | undefined;
	private readonly identity: HTMLElement | undefined;
	private readonly contextInformation: HTMLElement;
	private readonly configuration: HTMLElement | undefined;
	private readonly error: HTMLElement | undefined;
	private readonly controls = this._register(new DisposableStore());
	private readonly descriptionResources = this._register(new DisposableStore());
	private description: string | undefined;
	private readonly id = ++nextCardId;
	private entry: ModelCatalogEntry | undefined;
	private capabilityKey: string | undefined;
	private pending = false;
	private readonly choices: { input: HTMLInputElement; label: HTMLElement; selected(): boolean; }[] = [];

	public get element(): HTMLElement { return this.domNode; }

	constructor(
		ownerDocument: Document,
		private readonly options: IModelCardOptions | undefined,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-chat-model-card';
		this.domNode.tabIndex = -1;
		this.descriptionDomNode = h(ownerDocument, 'div');
		this.descriptionDomNode.className = 'ash-chat-model-card-description';
		this.contextInformation = h(ownerDocument, 'p');
		this.contextInformation.className = 'ash-chat-model-card-context';
		this.domNode.append(this.descriptionDomNode, this.contextInformation);
		if (options) {
			this.domNode.classList.add('ash-chat-model-card-configurable');
			const title = h(ownerDocument, 'h3');
			title.className = 'ash-chat-model-card-title';
			this.title = this._register(new IconLabel(title, { label: '' }));
			this.identity = h(ownerDocument, 'p');
			this.identity.className = 'ash-chat-model-card-identity';
			this.domNode.prepend(title, this.identity);
			this.configuration = h(ownerDocument, 'div');
			this.error = h(ownerDocument, 'div');
			this.error.className = 'ash-chat-model-picker-error';
			this.error.setAttribute('role', 'status');
			this.error.hidden = true;
			this.domNode.append(this.configuration, this.error);
		}
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(entry: ModelCatalogEntry): void {
		this.entry = entry;
		const description = entry.description?.trim() ?? '';
		this.domNode.setAttribute('aria-label', entry.displayName);
		if (description !== this.description) {
			const hadFocus = this.descriptionDomNode.contains(this.domNode.ownerDocument.activeElement);
			this.description = description;
			this.descriptionResources.clear();
			renderModelDescription(description, this.openerService, this.descriptionResources, undefined, this.descriptionDomNode);
			if (hadFocus && !this.descriptionDomNode.contains(this.domNode.ownerDocument.activeElement)) { this.focus(); }
		}
		this.descriptionDomNode.hidden = !description;
		const context = entry.maximumContextWindow ?? entry.contextWindow;
		this.contextInformation.hidden = !context || (!!this.options && entry.longContext !== null);
		this.contextInformation.textContent = context
			? localize('chat.modelPicker.contextInformation', '{0}: {1}', getMaxContextLabel(), getModelConfigValueLabel(context)) : '';
		this.domNode.hidden = !this.options && !description && this.contextInformation.hidden;
		const accessibleDescription = [this.descriptionDomNode.textContent?.trim(), this.contextInformation.hidden ? undefined : this.contextInformation.textContent].filter(Boolean).join(' ');
		if (accessibleDescription) { this.domNode.setAttribute('aria-description', accessibleDescription); }
		else { this.domNode.removeAttribute('aria-description'); }
		if (!this.options) { return; }
		this.title!.setLabel(entry.displayName, undefined, { icon: getModelProviderIcon(entry) });
		this.identity!.textContent = `${entry.model.provider}/${entry.model.model}`;
		// Preference updates retain the radio DOM, including the option being used by the keyboard.
		const key = JSON.stringify([entry.model, entry.supportedReasoningEfforts, entry.defaultReasoningEffort,
		entry.accelerationOptions, entry.longContext === null, entry.defaultContextWindow, entry.maximumContextWindow, entry.longContext === null ? entry.contextWindow : undefined]);
		if (key !== this.capabilityKey) {
			this.capabilityKey = key;
			const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
			this.renderConfiguration();
			if (hadFocus && !this.domNode.contains(this.domNode.ownerDocument.activeElement)) { this.focus(); }
		}
		this.updateChoices();
	}

	private renderConfiguration(): void {
		const entry = this.entry!;
		const container = this.configuration!;
		this.controls.clear();
		this.choices.length = 0;
		container.replaceChildren();
		if (entry.supportedReasoningEfforts?.length) {
			const group = this.createGroup(localize('chat.modelPicker.thinkingEffort', 'Thinking Level'));
			for (const option of modelPickerEffortOptions(entry, this.options!.getSelectedReasoningEffort())) {
				this.addChoice(group, 'effort', option.label, option.description,
					() => modelPickerEffortOptions(this.entry!, this.options!.getSelectedReasoningEffort()).some(current => current.effort === option.effort && current.checked),
					() => this.options!.onReasoningEffortChange(option.value));
			}
		}
		if (entry.longContext !== null) {
			const group = this.createGroup(localize('chat.modelPicker.contextSize', 'Context Size'));
			for (const longContext of [false, true]) {
				const tokens = longContext ? entry.maximumContextWindow : entry.defaultContextWindow;
				let label = longContext ? localize('chat.modelPicker.longContextOn', 'Long context on') : localize('chat.modelPicker.longContextOff', 'Long context off');
				if (tokens) {
					label = longContext ? getModelConfigValueLabel(tokens) : localize('chat.modelPicker.defaultContext', '{0} (Default)', getModelConfigValueLabel(tokens));
				}
				this.addChoice(group, 'context', label, undefined, () => this.entry!.longContext === longContext,
					() => this.options!.onLongContextChange(longContext));
			}
		}
		const acceleration = modelPickerAccelerationOptions(entry);
		if (acceleration.length) {
			const group = this.createGroup(localize('chat.modelPicker.speed', 'Speed'));
			for (const option of acceleration) {
				this.addChoice(group, 'acceleration', option.label, option.description,
					() => modelPickerAccelerationOptions(this.entry!).some(current => current.value === option.value && current.checked),
					() => this.options!.onAccelerationChange(option.value));
			}
		}
		if (this.choices.length === 0) {
			const message = h(container.ownerDocument, 'p');
			message.className = 'ash-chat-model-card-identity';
			message.textContent = localize('chat.modelPicker.noConfiguration', 'This model has no configurable options.');
			container.append(message);
		}
	}

	private createGroup(label: string): HTMLElement {
		const group = h(this.domNode.ownerDocument, 'fieldset');
		group.className = 'ash-chat-model-card-options';
		group.setAttribute('role', 'radiogroup');
		const legend = h(group.ownerDocument, 'legend');
		legend.textContent = label;
		group.append(legend);
		this.configuration!.append(group);
		return group;
	}

	private addChoice(group: HTMLElement, name: string, text: string, description: string | undefined, selected: () => boolean, save: () => Promise<void>): void {
		const label = h(group.ownerDocument, 'label');
		label.className = 'ash-chat-model-card-choice';
		const input = h(group.ownerDocument, 'input');
		input.type = 'radio';
		input.name = `chat-model-${this.id}-${name}`;
		input.setAttribute('aria-label', text);
		if (description) { input.setAttribute('aria-description', description); }
		const caption = h(group.ownerDocument, 'span');
		caption.textContent = text;
		label.append(input, caption);
		group.append(label);
		this.choices.push({ input, label, selected });
		this.controls.add(addDisposableListener(input, 'change', () => { if (input.checked) { void this.save(save); } }));
	}

	private updateChoices(): void {
		for (const choice of this.choices) {
			choice.input.checked = choice.selected();
			choice.input.disabled = this.pending;
			choice.label.classList.toggle('checked', choice.input.checked);
		}
	}

	private async save(save: () => Promise<void>): Promise<void> {
		if (this.pending) { return; }
		this.pending = true;
		this.error!.hidden = true;
		this.domNode.setAttribute('aria-busy', 'true');
		const focused = this.domNode.ownerDocument.activeElement as HTMLElement;
		this.updateChoices();
		try {
			await save();
		} catch {
			if (!this.isDisposed) {
				this.error!.textContent = localize('chat.modelPicker.preferencesFailed', 'Could not update model settings');
				this.error!.hidden = false;
			}
		} finally {
			if (!this.isDisposed) {
				this.pending = false;
				this.domNode.removeAttribute('aria-busy');
				this.updateChoices();
				if (focused.isConnected && this.domNode.ownerDocument.activeElement === this.domNode.ownerDocument.body) { focused.focus(); }
			}
		}
	}

	public focus(): void {
		if (!this.domNode.hidden) { this.domNode.focus(); }
	}
}
