import './media/arkdownEmbeddedEditor.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { ArkdownEmbeddedEditor, ArkdownJsonField, ArkdownNode } from './arkdownRuntime.js';

export function createArkdownEmbeddedEditor(document: Document, editor: ArkdownEmbeddedEditor, source: string, lifetime: DisposableStore, apply: (replacement: string) => void): HTMLElement {
	if (editor.kind === 'task_progress') {
		const title = localize({ bundle: 'ash.arkdown', key: 'taskProgress' }, 'Task progress');
		return h(document, 'figure', { className: 'ash-markdown-embedded ash-markdown-task-progress' },
			h(document, 'figcaption', {}, h(document, 'strong', {}, title), h(document, 'span', { attributes: { role: 'status' } })),
			h(document, 'progress', { attributes: { 'aria-label': title } }));
	}
	return createJsonForm(document, editor.fields, editor.maxBytes, source, lifetime, apply);
}

export function updateArkdownTaskProgress(container: HTMLElement, nodes: readonly ArkdownNode[]): void {
	const views = container.querySelectorAll('.ash-markdown-task-progress');
	if (views.length === 0) return;
	let completed = 0;
	let total = 0;
	const count = (node: ArkdownNode): void => {
		if (node.kind === 'task_list_marker') {
			total++;
			if (node.checked) completed++;
		}
		node.children.forEach(count);
	};
	nodes.forEach(count);
	const summary = localize({ bundle: 'ash.arkdown', key: 'taskProgressSummary' }, '{0} of {1} tasks complete', completed, total);
	for (const view of views) {
		const status = view.querySelector('[role="status"]')!;
		const progress = view.querySelector('progress')!;
		if (status.textContent !== summary) {
			status.textContent = summary;
			progress.max = Math.max(1, total);
			progress.value = completed;
			progress.setAttribute('aria-valuetext', summary);
		}
	}
}

const jsonNumber = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;

function createJsonForm(document: Document, fields: readonly ArkdownJsonField[], maxBytes: number, source: string, lifetime: DisposableStore, apply: (replacement: string) => void): HTMLFormElement {
	const title = localize({ bundle: 'ash.arkdown', key: 'jsonForm' }, 'JSON form');
	const form = h(document, 'form', { className: 'ash-markdown-embedded ash-markdown-json-form', attributes: { 'aria-label': title } });
	const grid = h(document, 'div', { className: 'ash-markdown-json-fields' });
	const status = h(document, 'span', { className: 'ash-markdown-json-error', attributes: { role: 'status' } });
	const save = h(document, 'button', { attributes: { type: 'submit' } }, localize({ bundle: 'ash.arkdown', key: 'applyJson' }, 'Apply Changes'));
	const fieldset = h(document, 'fieldset', {}, h(document, 'legend', {}, title), grid,
		h(document, 'div', { className: 'ash-markdown-json-actions' }, status, save));
	form.append(fieldset);
	const controls: { field: Exclude<ArkdownJsonField, { kind: 'null'; }>; input: HTMLInputElement; }[] = [];
	for (const field of fields) {
		const name = h(document, 'span', {}, field.name.trim() ? field.name : JSON.stringify(field.name));
		if (field.kind === 'null') {
			grid.append(h(document, 'div', { className: 'ash-markdown-json-field' }, name, h(document, 'code', {}, 'null')));
			continue;
		}
		const input = h(document, 'input', { attributes: { type: field.kind === 'boolean' ? 'checkbox' : 'text', spellcheck: 'false' } });
		if (field.kind === 'boolean') input.checked = field.value;
		else input.value = field.value;
		if (field.kind === 'number') {
			input.inputMode = 'decimal';
			lifetime.add(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
		}
		grid.append(h(document, 'label', { className: 'ash-markdown-json-field' }, name, input));
		controls.push({ field, input });
	}
	// The enclosing contenteditable handles Markdown edits. Keep native form input and IME local.
	for (const event of ['beforeinput', 'copy', 'cut', 'paste', 'compositionstart', 'compositionend', 'drop'] as const) {
		lifetime.add(addDisposableListener(form, event, value => value.stopPropagation()));
	}
	lifetime.add(addDisposableListener(form, 'submit', event => {
		event.preventDefault();
		if (fieldset.disabled) return;
		status.textContent = '';
		let replacement = source;
		// Replace only changed tokens, from right to left, retaining the fence and JSON formatting.
		for (let index = controls.length - 1; index >= 0; index--) {
			const { field, input } = controls[index];
			const value = field.kind === 'boolean' ? input.checked : input.value;
			if (value === field.value) continue;
			if (field.kind === 'number' && (!jsonNumber.test(input.value) || !Number.isFinite(Number(input.value)))) {
				input.setCustomValidity(localize({ bundle: 'ash.arkdown', key: 'invalidJsonNumber' }, 'Enter a valid JSON number.'));
				input.reportValidity();
				return;
			}
			const encoded = field.kind === 'number' ? input.value : JSON.stringify(value);
			replacement = replacement.slice(0, field.range.start) + encoded + replacement.slice(field.range.end);
		}
		if (new TextEncoder().encode(replacement).length > maxBytes) {
			status.textContent = localize({ bundle: 'ash.arkdown', key: 'jsonFormTooLarge' }, 'The JSON form exceeds its size limit.');
		} else if (replacement !== source) {
			apply(replacement);
		}
	}));
	return form;
}
