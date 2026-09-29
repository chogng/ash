import { h } from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

/** Shows details for the active model beside the picker menu. */
export class ModelPickerDetailsMenu {
	private readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly identity: HTMLElement;
	private readonly context: HTMLElement;
	private readonly efforts: HTMLElement;

	constructor(private readonly picker: HTMLElement) {
		const document = picker.ownerDocument;
		this.element = h(document, 'section');
		this.element.className = 'ash-chat-model-picker-details-menu';
		this.title = h(document, 'strong');
		this.identity = h(document, 'p');
		this.context = h(document, 'p');
		this.efforts = h(document, 'p');
		this.element.append(this.title, this.identity, this.context, this.efforts);
		this.element.hidden = true;
		picker.append(this.element);
	}

	public show(entry: ModelCatalogEntry, row: HTMLElement): void {
		this.element.setAttribute('aria-label', entry.displayName);
		this.title.textContent = entry.displayName;
		this.identity.textContent = `${entry.model.provider}/${entry.model.model}`;
		this.context.textContent = entry.contextWindow
			? localize('chat.modelPicker.contextWindow', '{0} context window', entry.contextWindow.toLocaleString())
			: '';
		this.context.hidden = !entry.contextWindow;
		this.efforts.textContent = entry.supportedReasoningEfforts?.length
			? localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.join(', '))
			: '';
		this.efforts.hidden = !entry.supportedReasoningEfforts?.length;
		this.element.hidden = false;
		const pickerBounds = this.picker.getBoundingClientRect();
		const rowBounds = row.getBoundingClientRect();
		const detailsBounds = this.element.getBoundingClientRect();
		const viewport = this.picker.ownerDocument.defaultView!;
		const rightSpace = viewport.innerWidth - pickerBounds.right;
		this.element.classList.toggle('is-left', pickerBounds.left >= detailsBounds.width + 8 || pickerBounds.left > rightSpace);
		const bottom = viewport.innerHeight - pickerBounds.top - detailsBounds.height - 8;
		this.element.style.top = `${Math.max(-pickerBounds.top + 8, Math.min(rowBounds.top - pickerBounds.top, bottom))}px`;
	}

	public hide(): void {
		this.element.hidden = true;
	}
}
