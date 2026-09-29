import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortLabel } from './modelPickerModelConfig.js';

let nextCardId = 0;

export interface IModelCardOptions {
	readonly entry: ModelCatalogEntry;
	readonly selectedEffort: ModelReasoningEffort | undefined;
	readonly selectReasoningEffort: (effort: ModelReasoningEffort | undefined) => Promise<void>;
}

/** Shows a model's information and editable thinking effort in the picker details page. */
export class ModelCard extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly choices: HTMLInputElement[] = [];
	private readonly error: HTMLElement;
	private selectedEffort: ModelReasoningEffort | undefined;

	constructor(private readonly options: IModelCardOptions, ownerDocument: Document) {
		super();
		const { entry } = options;
		this.selectedEffort = options.selectedEffort;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-chat-model-card';
		const title = h(ownerDocument, 'h2');
		title.textContent = entry.displayName;
		const identity = h(ownerDocument, 'p');
		identity.className = 'ash-chat-model-card-identity';
		identity.textContent = `${entry.model.provider}/${entry.model.model}`;
		this.domNode.append(title, identity);
		if (entry.contextWindow) {
			const context = h(ownerDocument, 'p');
			context.textContent = localize('chat.modelPicker.contextWindow', '{0} context window', entry.contextWindow.toLocaleString());
			this.domNode.append(context);
		}
		if (entry.supportedReasoningEfforts?.length) {
			const groupName = `ash-chat-model-effort-${++nextCardId}`;
			const fieldset = h(ownerDocument, 'fieldset');
			fieldset.className = 'ash-chat-model-card-effort';
			const legend = h(ownerDocument, 'legend');
			legend.textContent = localize('chat.modelPicker.thinkingEffort', 'Thinking Effort');
			fieldset.append(legend);
			const choices: readonly (ModelReasoningEffort | undefined)[] = [undefined, ...entry.supportedReasoningEfforts];
			for (const effort of choices) {
				const label = h(ownerDocument, 'label');
				const input = h(ownerDocument, 'input');
				input.type = 'radio';
				input.name = groupName;
				input.value = effort ?? '';
				input.checked = effort === this.selectedEffort;
				const text = h(ownerDocument, 'span');
				text.textContent = modelPickerEffortLabel(effort);
				label.append(input, text);
				fieldset.append(label);
				this.choices.push(input);
				this._register(addDisposableListener(input, 'change', () => {
					if (input.checked) {
						void this.selectEffort(effort);
					}
				}));
			}
			this.domNode.append(fieldset);
		}
		this.error = h(ownerDocument, 'p');
		this.error.className = 'ash-chat-model-card-error';
		this.error.setAttribute('role', 'status');
		this.error.hidden = true;
		this.domNode.append(this.error);
	}

	public focus(fallback: HTMLElement): void {
		(this.choices.find(choice => choice.checked) ?? this.choices[0] ?? fallback).focus();
	}

	private async selectEffort(effort: ModelReasoningEffort | undefined): Promise<void> {
		this.error.hidden = true;
		try {
			await this.options.selectReasoningEffort(effort);
			this.selectedEffort = effort;
		} catch {
			this.error.textContent = localize('chat.modelPicker.effortFailed', 'Could not set thinking effort');
			this.error.hidden = false;
			for (const choice of this.choices) {
				choice.checked = choice.value === (this.selectedEffort ?? '');
			}
		}
	}
}
