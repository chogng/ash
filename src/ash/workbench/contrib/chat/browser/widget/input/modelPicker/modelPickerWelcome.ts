import { getActiveDocument, h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import type { IModelPickerDestination } from './modelPickerTabs.js';

/** Renders the destination's explanation and actions; their host owns navigation and state. */
export class ModelPickerWelcome extends DisposableStore {
	public readonly element: HTMLElement;

	constructor(destination: IModelPickerDestination, document: Document = getActiveDocument()) {
		super();
		this.element = h(document, 'div');
		this.element.className = 'ash-chat-model-picker-empty';
		this.add(toDisposable(() => this.element.remove()));
		for (const placeholder of destination.placeholders) {
			const title = h(document, 'div');
			title.className = 'ash-chat-model-picker-empty-message';
			title.setAttribute('role', 'status');
			title.textContent = placeholder.label;
			const message = h(document, 'div');
			message.className = 'ash-chat-model-picker-empty-guidance';
			message.textContent = placeholder.message;
			this.element.append(title, message);
			if (placeholder.action) {
				this.add(new Button(this.element, {
					...defaultButtonStyles, presentation: 'primary',
					label: placeholder.action.label, onClick: placeholder.action.run,
				}));
			}
		}
	}
}
