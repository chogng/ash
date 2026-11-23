import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';

export function createEmbeddedEditor(editor, source, messages, lifetime, apply) {
	switch (editor.kind) {
		case 'taskProgress': return createTaskProgress(messages);
		case 'jsonForm': return createJsonForm(editor, source, messages, lifetime, apply);
	}
	throw new TypeError('Unknown Markdown code block editor');
}

function createTaskProgress(messages) {
	const element = document.createElement('figure');
	element.className = 'ash-markdown-embedded ash-markdown-task-progress';
	const caption = document.createElement('figcaption');
	const title = document.createElement('strong');
	title.textContent = messages.taskProgress;
	const status = document.createElement('span');
	status.setAttribute('role', 'status');
	caption.append(title, status);
	const progress = document.createElement('progress');
	progress.setAttribute('aria-label', messages.taskProgress);
	element.append(caption, progress);
	return element;
}

export function updateTaskProgress(view, [completed, total], messages) {
	const counts = [completed, total];
	const summary = messages.taskProgressSummary.replace(/\{([01])\}/gu, (_, index) => String(counts[index]));
	for (const element of view.querySelectorAll('.ash-markdown-task-progress')) {
		const status = element.querySelector('[role="status"]');
		const progress = element.querySelector('progress');
		if (status.textContent !== summary) {
			status.textContent = summary;
			progress.max = Math.max(1, total);
			progress.value = completed;
			progress.setAttribute('aria-valuetext', summary);
		}
	}
}

const jsonNumber = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;

function createJsonForm({ fields, maxBytes }, source, messages, lifetime, apply) {
	const form = document.createElement('form');
	form.className = 'ash-markdown-embedded ash-markdown-json-form';
	form.setAttribute('aria-label', messages.jsonForm);
	const fieldset = document.createElement('fieldset');
	const legend = document.createElement('legend');
	legend.textContent = messages.jsonForm;
	const grid = document.createElement('div');
	grid.className = 'ash-markdown-json-fields';
	fieldset.append(legend, grid);
	const controls = [];
	for (const field of fields) {
		const label = document.createElement(field.kind === 'null' ? 'div' : 'label');
		label.className = 'ash-markdown-json-field';
		const name = document.createElement('span');
		name.textContent = field.name.trim() ? field.name : JSON.stringify(field.name);
		label.append(name);
		if (field.kind === 'null') {
			const value = document.createElement('code');
			value.textContent = 'null';
			label.append(value);
		} else {
			const input = document.createElement('input');
			if (field.kind === 'boolean') {
				input.type = 'checkbox';
				input.checked = field.value;
			} else {
				input.type = 'text';
				input.value = field.value;
				input.spellcheck = false;
				if (field.kind === 'number') {
					input.inputMode = 'decimal';
					lifetime.add(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
				}
			}
			label.append(input);
			controls.push({ field, input });
		}
		grid.append(label);
	}
	const submit = document.createElement('button');
	submit.type = 'button';
	submit.textContent = messages.applyJson;
	const status = document.createElement('span');
	status.className = 'ash-markdown-json-error';
	status.setAttribute('role', 'status');
	const actions = document.createElement('div');
	actions.className = 'ash-markdown-json-actions';
	actions.append(status, submit);
	fieldset.append(actions);
	form.append(fieldset);
	// The webview forbids HTML submission. Applying is a local editor action.
	lifetime.add(addDisposableListener(form, 'keydown', event => {
		if (event.key !== 'Enter' || event.isComposing || !event.target.matches('input[type=text]')) return;
		event.preventDefault();
		submit.click();
	}));
	lifetime.add(addDisposableListener(submit, 'click', () => {
		if (fieldset.disabled) return;
		status.textContent = '';
		let replacement = source;
		// Ranges address the original fence. Applying from the end keeps earlier
		// ranges valid and preserves every key, separator and line break.
		for (let index = controls.length - 1; index >= 0; index--) {
			const { field, input } = controls[index];
			const value = field.kind === 'boolean' ? input.checked : input.value;
			if (value === field.value) continue;
			if (field.kind === 'number' && (!jsonNumber.test(value) || !Number.isFinite(Number(value)))) {
				input.setCustomValidity(messages.invalidJsonNumber);
				input.reportValidity();
				return;
			}
			const encoded = field.kind === 'number' ? value : JSON.stringify(value);
			replacement = replacement.slice(0, field.start) + encoded + replacement.slice(field.end);
		}
		if (new TextEncoder().encode(replacement).length > maxBytes) {
			status.textContent = messages.jsonFormTooLarge;
			return;
		}
		if (replacement !== source) apply(replacement);
	}));
	return form;
}
