import './media/inlineRenameInput.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';

interface InlineRenameInputOptions {
	readonly label: string;
	readonly description?: string;
	readonly maxLength?: number;
	readonly onAccept: () => void;
	readonly onCancel: () => void;
	readonly onBlur: () => void;
}

/** Renders the input and forwards editing gestures to the title that owns it. */
export function renderInlineRenameInput(container: HTMLElement, options: InlineRenameInputOptions, store: DisposableStore): HTMLInputElement {
	const input = h(container.ownerDocument, 'input', {
		className: 'ash-inline-rename-input ash-titlebar-interactive-region',
		properties: { type: 'text', hidden: true },
		attributes: { 'aria-label': options.label },
	});
	if (options.description) input.setAttribute('aria-description', options.description);
	if (options.maxLength !== undefined) input.maxLength = options.maxLength;
	container.append(input);
	store.add(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
	store.add(addDisposableListener(input, 'keydown', event => {
		// A surrounding toolbar must leave text navigation to the input.
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
			event.stopPropagation();
		}
		if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'Enter') options.onAccept();
		else options.onCancel();
	}));
	store.add(addDisposableListener(input, 'blur', options.onBlur));
	store.add(toDisposable(() => input.remove()));
	return input;
}

export function showInlineRenameInput(input: HTMLInputElement, value: string): void {
	input.setCustomValidity('');
	input.value = value;
	input.readOnly = false;
	input.hidden = false;
	input.focus();
	input.select();
}
