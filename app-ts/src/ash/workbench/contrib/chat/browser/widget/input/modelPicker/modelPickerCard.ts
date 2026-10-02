import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortLabel, modelPickerEffortOptions } from './modelPickerModelConfig.js';

let nextCardId = 0;

export interface IModelCardOptions {
	readonly entry: ModelCatalogEntry;
	readonly selectedEffort: ModelReasoningEffort | undefined;
	/** Only the current chat model exposes a write operation. Other cards are informational. */
	readonly selectReasoningEffort?: (effort: ModelReasoningEffort | undefined) => Promise<void>;
}

/** Shows model information and configures the current chat model without moving focus on refresh. */
export class ModelCard extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly contentDomNode: HTMLElement;
	private readonly errorDomNode: HTMLElement;
	private readonly controls = this._register(new DisposableStore());
	private readonly choices: { input: HTMLInputElement; effort: ModelReasoningEffort | undefined }[] = [];
	private options: IModelCardOptions | undefined;
	private isSaving = false;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-chat-model-card';
		this.domNode.tabIndex = -1;
		this.contentDomNode = h(ownerDocument, 'div');
		this.errorDomNode = h(ownerDocument, 'p');
		this.errorDomNode.className = 'ash-chat-model-card-error';
		this.errorDomNode.setAttribute('role', 'status');
		this.errorDomNode.hidden = true;
		this.domNode.append(this.contentDomNode, this.errorDomNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(options: IModelCardOptions): void {
		const shouldRender = this.options?.entry !== options.entry || Boolean(this.options?.selectReasoningEffort) !== Boolean(options.selectReasoningEffort);
		this.options = options;
		if (shouldRender) {
			this.controls.clear();
			this.choices.length = 0;
			this.contentDomNode.replaceChildren();
			const ownerDocument = this.domNode.ownerDocument;
			const { entry } = options;
			this.domNode.setAttribute('aria-label', entry.displayName);
			const title = h(ownerDocument, 'h2');
			title.textContent = entry.displayName;
			const identity = h(ownerDocument, 'p');
			identity.className = 'ash-chat-model-card-identity';
			identity.textContent = `${entry.model.provider}/${entry.model.model}`;
			this.contentDomNode.append(title, identity);
			if (entry.contextWindow) {
				const context = h(ownerDocument, 'p');
				context.textContent = localize('chat.modelPicker.contextWindow', '{0} context window', entry.contextWindow.toLocaleString());
				this.contentDomNode.append(context);
			}
			if (entry.supportedReasoningEfforts?.length) {
				if (options.selectReasoningEffort) {
					const groupName = `ash-chat-model-effort-${++nextCardId}`;
					const fieldset = h(ownerDocument, 'fieldset');
					fieldset.className = 'ash-chat-model-card-effort';
					const legend = h(ownerDocument, 'legend');
					legend.textContent = localize('chat.modelPicker.thinkingEffort', 'Thinking Level');
					fieldset.append(legend);
					for (const option of modelPickerEffortOptions(entry, options.selectedEffort)) {
						const label = h(ownerDocument, 'label');
						const input = h(ownerDocument, 'input');
						input.type = 'radio';
						input.name = groupName;
						input.value = option.value ?? '';
						const text = h(ownerDocument, 'span');
						text.textContent = option.label;
						label.append(input, text);
						if (option.isDefault) {
							const badge = h(ownerDocument, 'span');
							badge.className = 'ash-chat-model-card-default';
							badge.textContent = modelPickerEffortLabel(undefined);
							input.setAttribute('aria-description', badge.textContent);
							label.append(badge);
						}
						fieldset.append(label);
						this.choices.push({ input, effort: option.effort });
						this.controls.add(addDisposableListener(input, 'change', () => {
							if (input.checked) { void this.selectEffort(option.value); }
						}));
					}
					this.contentDomNode.append(fieldset);
				} else {
					const efforts = h(ownerDocument, 'p');
					efforts.textContent = localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.map(modelPickerEffortLabel).join(', '));
					this.contentDomNode.append(efforts);
				}
			}
		}
		this.updateChecked();
	}

	public focus(): void {
		(this.choices.find(choice => choice.input.checked)?.input ?? this.domNode).focus();
	}

	private updateChecked(): void {
		for (const choice of this.choices) {
			choice.input.checked = choice.effort === (this.options?.selectedEffort ?? this.options?.entry.modelReasoningEffort);
		}
	}

	private async selectEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		if (this.isSaving) { this.updateChecked(); return; }
		const select = this.options?.selectReasoningEffort;
		if (!select) { return; }
		this.isSaving = true;
		this.domNode.setAttribute('aria-busy', 'true');
		this.errorDomNode.hidden = true;
		try {
			await select(effort);
		} catch {
			if (this.isDisposed) { return; }
			this.errorDomNode.textContent = localize('chat.modelPicker.effortFailed', 'Could not set thinking effort');
			this.errorDomNode.hidden = false;
		} finally {
			if (!this.isDisposed) {
				this.isSaving = false;
				this.domNode.removeAttribute('aria-busy');
				this.updateChecked();
			}
		}
	}
}
