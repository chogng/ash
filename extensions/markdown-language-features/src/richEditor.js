import {
	commands,
	EditorController,
	EditorModel,
	EditorView,
	OffsetRange,
	Selection,
	StringEdit,
	StringReplacement,
	StringValue,
} from '@vscode/markdown-editor';
import { autorun, Disposable } from '@vscode/observables';
import '@vscode/markdown-editor/editor.css';
import '../media/richEditor.css';

/** The sandbox holds a transient view; the host TextModel owns versions, history and saving. */
class MarkdownEditor extends Disposable {
	constructor(initial) {
		super();
		this.api = acquireAshWebviewApi();
		this.messages = initial.messages;
		this.version = initial.version;
		this.confirmed = initial.text;
		this.pending = undefined;
		this.historyQueue = [];
		this.historyPending = false;
		this.conflict = false;
		this.saving = false;
		this.updating = false;
		this.model = new EditorModel();
		this.model.sourceText.set(new StringValue(initial.text), undefined);
		this.model.readonlyMode.set(initial.readOnly, undefined);
		this.toolbar = document.createElement('div');
		this.toolbar.className = 'ash-markdown-toolbar';
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', this.messages.toolbar);
		this.buttons = [];
		this.status = document.createElement('div');
		this.status.className = 'ash-markdown-status';
		this.status.setAttribute('role', 'status');
		this.reload = this.button('reload', () => this.adopt(this.latest), false);
		this.reload.hidden = true;
		this.view = this._register(
			new EditorView(this.model, {
				classNames: ['ash-markdown-content'],
				showReadonlyToggle: false,
				onOpenLink: (href) => this.api.postMessage({ href }),
				onToggleCheckbox: (item, checked) => {
					if (!this.model.readonlyMode.get()) { this.model.setTaskCheckboxChecked(item, checked); }
				},
			}),
		);
		this.view.element.setAttribute('aria-label', this.messages.editor);
		this.view.element.setAttribute('aria-multiline', 'true');
		// The library's read-only display mode permits task updates; file permissions forbid all edits.
		// Rendered task controls also need names from their visible task text.
		const taskControls = new MutationObserver(() => this.updateTaskControls());
		taskControls.observe(this.view.element, { childList: true, subtree: true });
		this._register({ dispose: () => taskControls.disconnect() });
		this.controller = this._register(
			new EditorController(this.model, this.view, {
				find: false,
				historyStrategy: { undo: () => this.history('undo'), redo: () => this.history('redo') },
			}),
		);
		for (const [key, action] of [
			['bold', () => this.wrap('**')],
			['italic', () => this.wrap('*')],
			['strike', () => this.wrap('~~')],
			['code', () => this.wrap('`')],
			['heading', () => this.prefix('# ')],
			['list', () => this.prefix('- ')],
			['quote', () => this.prefix('> ')],
			['link', () => this.openLinkForm()],
			[
				'table',
				() =>
					this.replace(
						`\n\n| ${this.messages.tableHeader} | ${this.messages.tableHeader} |\n| --- | --- |\n| ${this.messages.tableCell} | ${this.messages.tableCell} |\n\n`,
					),
			],
			['undo', () => this.history('undo')],
			['redo', () => this.history('redo')],
			[
				'save',
				() => {
					this.saving = true;
					this.flush();
				},
			],
		]) { this.button(key, action, true); }
		this.form = document.createElement('form');
		this.form.className = 'ash-markdown-link-form';
		this.form.hidden = true;
		this.url = document.createElement('input');
		this.url.setAttribute('aria-label', this.messages.linkTarget);
		this.url.placeholder = this.messages.linkTarget;
		const submit = document.createElement('button');
		submit.type = 'submit';
		submit.textContent = this.messages.insert;
		this.form.append(this.url, submit);
		this.listen(this.form, 'submit', (event) => {
			event.preventDefault();
			const target = this.url.value.trim();
			if (!target || /[\s<>]/u.test(target)) { return; }
			const selection = this.model.selection.get();
			const label = selection
				? this.model.sourceText.get().value.slice(selection.range.start, selection.range.endExclusive)
				: '';
			this.replace(`[${label || this.messages.linkText}](${target.replaceAll(')', '%29')})`);
			this.form.hidden = true;
		});
		const main = document.createElement('main');
		main.className = 'ash-markdown-main';
		main.append(this.view.element);
		document.body.append(this.toolbar, this.form, this.status, main);
		this.listen(this.toolbar, 'keydown', (event) => {
			const available = this.buttons.filter((button) => !button.hidden && !button.disabled);
			const index = available.indexOf(document.activeElement);
			if (index < 0) { return; }
			let next;
			if (event.key === 'Escape') {
				event.preventDefault();
				this.view.element.focus();
				return;
			}
			if (event.key === 'ArrowRight') { next = (index + 1) % available.length; }
			if (event.key === 'ArrowLeft') { next = (index + available.length - 1) % available.length; }
			if (event.key === 'Home') { next = 0; }
			if (event.key === 'End') { next = available.length - 1; }
			if (next !== undefined) {
				event.preventDefault();
				available[next].focus();
			}
		});
		this.listen(
			document,
			'keydown',
			(event) => {
				if (event.isComposing) { return; }
				if (event.altKey && event.key === 'F10') {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.buttons.find((button) => !button.disabled && !button.hidden)?.focus();
					return;
				}
				if (!(event.ctrlKey || event.metaKey)) { return; }
				if (event.target === this.url) { return; }
				if (['Home', 'End'].includes(event.key) && this.view.element.contains(event.target)) {
					event.preventDefault();
					event.stopImmediatePropagation();
					// Match the source editor's document navigation on every platform, including macOS.
					const id = `markdown.editor.cursorDocument${event.key === 'Home' ? 'Start' : 'End'}${event.shiftKey ? 'Select' : ''}`;
					this.controller.executeCommand(commands.find((command) => command.id === id));
				} else if (event.key.toLowerCase() === 's') {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.saving = true;
					this.flush();
				} else if (['b', 'i'].includes(event.key.toLowerCase())) {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.wrap(event.key.toLowerCase() === 'b' ? '**' : '*');
				} else if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
					event.preventDefault();
					event.stopImmediatePropagation();
					this.history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
				}
			},
			true,
		);
		this.listen(window, 'message', (event) => {
			if (event.source !== parent) { return; }
			const message = event.data;
			if (message.type === 'theme') {
				document.documentElement.style.cssText = message.variables;
			} else if (message.type === 'document') {
				if (message.version < this.version) { return; }
				this.latest = message;
				this.historyPending = false;
				if (message.version === this.version && message.text === this.confirmed) {
					this.model.readonlyMode.set(message.readOnly, undefined);
					this.updateButtons();
					this.flush();
				} else if (!this.pending && this.model.sourceText.get().value === this.confirmed && !this.conflict) {
					this.adopt(message);
					this.flush();
				}
			} else if (message.type === 'accepted') {
				const submitted = this.pending;
				this.pending = undefined;
				this.version = message.version;
				this.confirmed = message.text;
				if (this.model.sourceText.get().value === submitted && submitted !== message.text) { this.setText(message.text); }
				this.flush();
			} else if (message.type === 'editRejected') {
				this.pending = undefined;
				this.saving = false;
				this.conflict = true;
				this.historyQueue = [];
				this.historyPending = false;
				if (message.document) { this.latest = message.document; }
				this.model.readonlyMode.set(true, undefined);
				this.status.textContent =
					message.reason === 'readonly' ? this.messages.readonly : this.messages.conflict;
				this.reload.hidden = false;
				this.updateButtons();
			}
		});
		this._register(
			autorun((reader) => {
				reader.readObservable(this.model.sourceText);
				if (!this.updating) { this.flush(); }
			}),
		);
		this.updateButtons();
		this.api.postMessage({ type: 'ready' });
	}

	listen(target, type, listener, capture = false) {
		target.addEventListener(type, listener, capture);
		this._register({ dispose: () => target.removeEventListener(type, listener, capture) });
	}

	button(key, action, edits) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = this.messages[key];
		button.dataset.edits = String(edits);
		button.tabIndex = this.buttons.length ? -1 : 0;
		this.listen(button, 'click', () => {
			action();
			if (key !== 'link' && key !== 'reload') { this.view.element.focus(); }
		});
		this.listen(button, 'focus', () => {
			for (const item of this.buttons) { item.tabIndex = item === button ? 0 : -1; }
		});
		this.buttons.push(button);
		this.toolbar.append(button);
		return button;
	}

	updateButtons() {
		for (const button of this.buttons) { button.disabled = button.dataset.edits === 'true' && this.model.readonlyMode.get(); }
		const available = this.buttons.find((button) => !button.hidden && !button.disabled);
		if (available && !this.buttons.some((button) => !button.hidden && !button.disabled && button.tabIndex === 0)) { available.tabIndex = 0; }
		this.view.element.setAttribute('aria-readonly', String(this.model.readonlyMode.get()));
		this.updateTaskControls();
	}

	updateTaskControls() {
		for (const checkbox of this.view.element.querySelectorAll('input[type="checkbox"]')) {
			checkbox.disabled = this.model.readonlyMode.get();
			checkbox.setAttribute('aria-label', checkbox.closest('li').innerText.trim());
		}
	}

	setText(text) {
		this.updating = true;
		try {
			this.model.replaceSourceText(new StringValue(text));
		} finally {
			this.updating = false;
		}
	}

	adopt(document) {
		if (!document) { return; }
		this.pending = undefined;
		this.conflict = false;
		this.version = document.version;
		this.confirmed = document.text;
		this.setText(document.text);
		this.model.readonlyMode.set(document.readOnly, undefined);
		this.status.textContent = '';
		this.reload.hidden = true;
		this.updateButtons();
		this.view.element.focus();
	}

	flush() {
		if (this.updating || this.pending !== undefined || this.historyPending || this.conflict) { return; }
		const text = this.model.sourceText.get().value;
		if (text !== this.confirmed) {
			this.pending = text;
			this.api.postMessage({ type: 'edit', version: this.version, text });
		} else if (this.historyQueue.length) {
			this.historyPending = true;
			this.api.postMessage({ type: this.historyQueue.shift(), version: this.version });
		} else if (this.saving) {
			this.saving = false;
			this.api.postMessage({ type: 'save' });
		}
	}

	history(type) {
		if (this.conflict || this.model.readonlyMode.get()) { return; }
		this.historyQueue.push(type);
		this.flush();
	}

	replace(text, selection = this.model.selection.get()) {
		if (!selection || this.model.readonlyMode.get()) { return; }
		this.model.applyEdit(
			StringEdit.single(StringReplacement.replace(selection.range, text)),
			Selection.collapsed(selection.range.start + text.length),
		);
		this.view.element.focus();
	}

	wrap(marker) {
		const selection = this.model.selection.get();
		if (!selection || this.model.readonlyMode.get()) { return; }
		const { start, endExclusive } = selection.range;
		const source = this.model.sourceText.get().value;
		const text = source.slice(start, endExclusive);
		const surrounded =
			start >= marker.length &&
			source.slice(start - marker.length, start) === marker &&
			source.slice(endExclusive, endExclusive + marker.length) === marker;
		const editRange = surrounded
			? new OffsetRange(start - marker.length, endExclusive + marker.length)
			: selection.range;
		const replacement = surrounded ? text : marker + text + marker;
		const shift = surrounded ? -marker.length : marker.length;
		this.model.applyEdit(
			StringEdit.single(StringReplacement.replace(editRange, replacement)),
			new Selection(start + shift, endExclusive + shift),
		);
		this.view.element.focus();
	}

	prefix(marker) {
		const selection = this.model.selection.get();
		if (!selection || this.model.readonlyMode.get()) { return; }
		const text = this.model.sourceText.get().value;
		const start = text.lastIndexOf('\n', selection.range.start - 1) + 1;
		const finalOffset = Math.max(selection.range.start, selection.range.endExclusive - 1);
		const end = text.indexOf('\n', finalOffset);
		const lines = text.slice(start, end === -1 ? text.length : end).split('\n');
		const remove = lines.every(line => line.startsWith(marker));
		const replacements = [];
		let offset = start;
		for (const line of lines) {
			const existing = marker === '# ' ? /^#{1,6} /u.exec(line)?.[0] : line.startsWith(marker) ? marker : undefined;
			replacements.push(StringReplacement.replace(new OffsetRange(offset, offset + (existing?.length ?? 0)), remove ? '' : marker));
			offset += line.length + 1;
		}
		const edit = new StringEdit(replacements);
		this.model.applyEdit(edit, new Selection(edit.mapOffset(selection.anchor), edit.mapOffset(selection.active)));
		this.view.element.focus();
	}

	openLinkForm() {
		this.form.hidden = false;
		this.url.value = '';
		this.url.focus();
	}
}

const initial = JSON.parse(document.getElementById('ash-markdown-initial').textContent);
const editor = new MarkdownEditor(initial);
window.addEventListener('pagehide', () => editor.dispose(), { once: true });
