import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { InputBox } from '../../../src/ash/base/browser/ui/inputbox/inputBox.js';
import '../../markdown-math/src/styles.js';
import { inputEdit, sourceOffset, normalizedOffset, textEdit } from './sourceEdits.js';
import '../media/richEditor.css';

function shiftNode(node, shift) {
	if (!shift) return node;
	const [kind, value, detail] = node;
	if (kind === 'task') return [kind, value, detail + shift];
	if (['el', 'ol', 'a', 'img'].includes(kind)) return [kind, value, detail.map(child => shiftNode(child, shift))];
	return node;
}

function draftBlocks(parsed, text) {
	if (!parsed?.blocks) return [{ start: 0, end: text.length, content: ['raw', text] }];
	const blocks = parsed.blocks.map(([start, end, content]) => ({ start, end, content }));
	if (parsed.text === text) return blocks;
	// Until Rust returns the new tree, retain exact, unaffected source spans. Only
	// the edited region becomes raw source; its offsets never borrow an older tree.
	const edit = textEdit(parsed.text, text);
	const shift = edit.text.length - (edit.end - edit.start);
	const before = blocks.filter(block => block.end <= edit.start && block.end > block.start);
	const after = blocks.filter(block => block.start >= edit.end && block.end > block.start);
	const start = before.at(-1)?.end ?? 0;
	const end = after.length ? after[0].start + shift : text.length;
	return [
		...before,
		...(end > start || text.length === 0 ? [{ start, end, content: ['raw', text.slice(start, end)] }] : []),
		...after.map(block => ({ start: block.start + shift, end: block.end + shift, content: shiftNode(block.content, shift) })),
	];
}

/** A transient view and draft. The existing host owns versions, undo and saving. */
class MarkdownEditor extends Disposable {
	constructor(initial) {
		super();
		this.api = acquireVsCodeApi();
		this.messages = initial.messages;
		this.text = this.confirmed = initial.text;
		this.version = initial.version;
		this.latest = initial;
		this.parsed = initial;
		this.readOnly = initial.readOnly !== false;
		this.historyQueue = [];
		this.historyPending = false;
		this.saving = this.conflict = this.composing = false;
		this.pending = undefined;
		this.inputLifetime = this._register(new DisposableStore());
		this._register(toDisposable(() => { for (const entry of this.renderedBlocks ?? []) entry.lifetime.dispose(); }));
		this.toolbar = document.createElement('div');
		this.toolbar.className = 'ash-markdown-toolbar';
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', this.messages.toolbar);
		this.status = document.createElement('div');
		this.status.className = 'ash-markdown-status';
		this.status.setAttribute('role', 'status');
		this.view = document.createElement('div');
		this.view.className = 'ash-markdown-content';
		this.view.tabIndex = 0;
		this.view.setAttribute('role', 'document');
		this.view.setAttribute('aria-label', this.messages.editor);
		this.buttons = [];
		for (const [key, action, edits = true] of [
			['bold', () => this.wrap('**')], ['italic', () => this.wrap('*')],
			['strike', () => this.wrap('~~')], ['code', () => this.wrap('`')],
			['heading', () => this.prefix('# ')], ['list', () => this.prefix('- ')],
			['quote', () => this.prefix('> ')], ['link', () => this.openLinkForm()],
			['table', () => this.replace(`\n\n| ${this.messages.tableHeader} | ${this.messages.tableHeader} |\n| --- | --- |\n| ${this.messages.tableCell} | ${this.messages.tableCell} |\n\n`)],
			['source', () => this.activate(0, this.text.length, true)],
			['undo', () => this.history('undo')], ['redo', () => this.history('redo')],
			['save', () => { this.commitInput(); this.saving = true; this.flush(); }],
			['reload', () => this.adopt(this.latest), false],
		]) this.button(key, action, edits);
		this.reload = this.buttons.at(-1);
		this.reload.hidden = true;
		this.form = document.createElement('form');
		this.form.className = 'ash-markdown-link-form';
		this.form.hidden = true;
		this.url = document.createElement('input');
		this.url.setAttribute('aria-label', this.messages.linkTarget);
		this.url.placeholder = this.messages.linkTarget;
		const submit = document.createElement('button');
		submit.type = 'submit'; submit.textContent = this.messages.insert;
		this.form.append(this.url, submit);
		this.listen(this.form, 'submit', event => {
			event.preventDefault();
			const target = this.url.value.trim();
			if (!target || /[\s<>]/u.test(target) || !this.safeLink(target)) return;
			this.replace(`[${this.linkLabel || this.messages.linkText}](${target.replaceAll(')', '%29')})`);
			this.form.hidden = true;
		});
		const main = document.createElement('main');
		main.className = 'ash-markdown-main'; main.append(this.view);
		document.body.append(this.toolbar, this.form, this.status, main);
		this.listen(this.toolbar, 'keydown', event => {
			const available = this.buttons.filter(button => !button.disabled && !button.hidden);
			const index = available.indexOf(document.activeElement);
			const next = event.key === 'ArrowRight' ? (index + 1) % available.length
				: event.key === 'ArrowLeft' ? (index + available.length - 1) % available.length
					: event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : undefined;
			if (next !== undefined) { event.preventDefault(); available[next]?.focus(); }
			if (event.key === 'Escape') { event.preventDefault(); this.focus(); }
		});
		this.listen(document, 'keydown', event => this.keydown(event), true);
		this.listen(this.view, 'beforeinput', event => {
			if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
				event.preventDefault(); this.history(event.inputType === 'historyUndo' ? 'undo' : 'redo');
			}
		});
		this.listen(this.view, 'click', event => {
			const anchor = event.target.closest('a');
			if (anchor) { event.preventDefault(); this.api.postMessage({ href: anchor.getAttribute('href') }); return; }
			if (event.target.closest('input, textarea, .ash-input-box')) return;
			const block = event.target.closest('.ash-markdown-block');
			if (block) this.activate(Number(block.dataset.start), Number(block.dataset.end));
		});
		this.listen(window, 'message', event => { if (event.source === parent) this.receive(event.data); });
		this.listen(window, 'pagehide', () => this.dispose());
		this.render(); this.updateButtons();
		this.api.postMessage({ type: 'ready' });
	}

	listen(target, type, listener, capture = false, store) {
		const disposable = addDisposableListener(target, type, listener, capture);
		if (store) store.add(disposable); else this._register(disposable);
	}

	button(key, action, edits) {
		const button = document.createElement('button');
		button.type = 'button'; button.textContent = this.messages[key];
		button.dataset.edits = String(edits); button.tabIndex = this.buttons.length ? -1 : 0;
		// Formatting by mouse keeps the text selection. Keyboard users enter the
		// toolbar through Alt+F10 and can move between buttons with arrow keys.
		this.listen(button, 'mousedown', event => event.preventDefault());
		this.listen(button, 'click', () => { if (!this.composing) action(); });
		this.listen(button, 'focus', () => {
			for (const item of this.buttons) item.tabIndex = item === button ? 0 : -1;
		});
		this.buttons.push(button); this.toolbar.append(button);
	}

	updateButtons() {
		for (const button of this.buttons) button.disabled = button.dataset.edits === 'true' && (this.readOnly || this.conflict);
		const first = this.buttons.find(button => !button.hidden && !button.disabled);
		if (first && !this.buttons.some(button => !button.hidden && !button.disabled && button.tabIndex === 0)) first.tabIndex = 0;
		this.view.setAttribute('aria-readonly', String(this.readOnly || this.conflict));
		if (this.active && !this.composing) this.active.input.readOnly = this.readOnly || this.conflict;
		for (const checkbox of this.view.querySelectorAll('input[type=checkbox]')) checkbox.disabled = this.readOnly || this.conflict;
	}

	render() {
		const activeContainer = this.active?.whole ? this.view : this.active?.input.element.closest('.ash-markdown-block');
		this.inputLifetime.clear(); this.active = undefined;
		// Parsing belongs to this extension's Rust provider. Only results for
		// these exact bytes may supply ranges; the draft stays editable while waiting.
		const current = this.parsed?.text === this.text;
		const blocks = draftBlocks(this.parsed, this.text);
		if (current && this.parsed.parseError && !this.conflict) this.status.textContent = this.messages.parseError;
		this.blocks = blocks;
		const reusable = new Map();
		for (const entry of this.renderedBlocks ?? []) {
			if (entry.element === activeContainer || activeContainer === this.view) continue;
			const bucket = reusable.get(entry.key) ?? { entries: [], next: 0 };
			bucket.entries.push(entry); reusable.set(entry.key, bucket);
		}
		const previous = new Set(this.renderedBlocks);
		this.renderedBlocks = blocks.map(block => {
			const source = this.text.slice(block.start, block.end);
			const key = JSON.stringify([source, block.content]);
			const bucket = reusable.get(key);
			const reused = bucket?.entries[bucket.next++];
			if (reused) {
				previous.delete(reused);
				reused.element.dataset.start = block.start; reused.element.dataset.end = block.end;
				return reused;
			}
			const lifetime = new DisposableStore();
			const element = document.createElement('div');
			element.className = 'ash-markdown-block';
			element.dataset.start = block.start; element.dataset.end = block.end;
			if (!source.trim() && this.text.length) {
				element.classList.add('ash-markdown-gap'); element.setAttribute('aria-hidden', 'true');
			} else { element.tabIndex = 0; element.append(this.node(block.content, false, lifetime)); }
			return { key, element, lifetime };
		});
		for (const entry of previous) { entry.lifetime.dispose(); entry.element.remove(); }
		// Keep surviving nodes attached so selection and keyboard focus survive updates.
		let cursor = this.view.firstChild;
		for (const { element } of this.renderedBlocks) {
			if (element !== cursor) this.view.insertBefore(element, cursor);
			cursor = element.nextSibling;
		}
		while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
		this.updateButtons();
	}

	node([kind, value, detail, html], header = false, lifetime) {
		const children = (parent, nodes) => { for (const child of nodes) parent.append(this.node(child, header, lifetime)); return parent; };
		switch (kind) {
			case 't': return document.createTextNode(value);
			case 'raw': { const span = document.createElement('span'); span.className = 'ash-markdown-raw'; span.textContent = value; return span; }
			case 'code': { const code = document.createElement('code'); code.textContent = value; return code; }
			case 'br': return document.createElement('br');
			case 'hr': return document.createElement('hr');
			case 'math': {
				const element = document.createElement('span');
				element.className = 'ash-markdown-math';
				element.dataset.mathDisplay = detail ? 'block' : 'inline';
				// HTML comes from the authorized math provider, with trust disabled.
				// Missing capabilities retain visible, editable formula source.
				if (typeof html === 'string') element.innerHTML = html;
				else element.textContent = value;
				return element;
			}
			case 'el': {
				const element = document.createElement(header && value === 'td' ? 'th' : value);
				if (value === 'thead') {
					const row = document.createElement('tr');
					for (const child of detail) row.append(this.node(child, true, lifetime));
					element.append(row); return element;
				}
				return children(element, detail);
			}
			case 'ol': { const list = document.createElement('ol'); list.start = value; return children(list, detail); }
			case 'a': {
				const link = document.createElement(this.safeLink(value) ? 'a' : 'span');
				if (link.tagName === 'A') { link.setAttribute('href', value); link.setAttribute('rel', 'noopener noreferrer'); }
				return children(link, detail);
			}
			case 'img': {
				const label = children(document.createElement('span'), detail).textContent;
				// Opening a document must not load tracking images over the network.
				if (/[\u0000-\u0020\u007f]/u.test(value)) return document.createTextNode(label);
				if (/^(?:[a-z][\w+.-]*:|\/\/)/iu.test(value) && !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/iu.test(value)) return document.createTextNode(label);
				const image = document.createElement('img'); image.alt = label; image.src = value; return image;
			}
			case 'task': {
				const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value;
				checkbox.disabled = this.readOnly || this.conflict; checkbox.setAttribute('aria-label', this.messages.task);
				this.listen(checkbox, 'change', () => {
					if (this.readOnly || this.conflict || this.composing || !/^\[[ xX]\]$/u.test(this.text.slice(detail, detail + 3))) return;
					this.commitInput(); this.patch(detail + 1, detail + 2, checkbox.checked ? 'x' : ' '); this.render();
				}, false, lifetime);
				return checkbox;
			}
		}
		throw new TypeError('Unknown Markdown node');
	}

	safeLink(target) {
		const normalized = target.replace(/[\u0000-\u0020\u007f]/gu, '');
		return !/^[a-z][\w+.-]*:/iu.test(normalized) || /^(?:https?:|mailto:|file:|ash-remote:)/iu.test(normalized);
	}

	activate(start, end, whole = false) {
		if (this.readOnly || this.conflict || this.composing) return;
		if (!whole && this.active && start >= this.active.renderedEnd) {
			const shift = this.active.end - this.active.renderedEnd;
			start += shift; end += shift;
		}
		this.commitInput(); this.render();
		const block = whole ? undefined : this.blocks.find(block => block.start <= start && block.end >= end);
		if (!whole && !block) return;
		start = whole ? 0 : block.start; end = whole ? this.text.length : block.end;
		const container = whole ? this.view : [...this.view.children].find(element => Number(element.dataset.start) === start);
		container.replaceChildren();
		container.removeAttribute('aria-hidden'); container.classList.remove('ash-markdown-gap');
		const input = this.inputLifetime.add(new InputBox(container, { flexibleHeight: true, flexibleMaxHeight: 1000000, ariaLabel: whole ? this.messages.source : this.messages.editBlock }));
		input.element.classList.add('ash-markdown-input');
		input.value = this.text.slice(start, end); input.inputElement.spellcheck = false;
		this.active = { start, end, input, whole, renderedEnd: end };
		this.inputLifetime.add(input.onDidChange(() => { if (!this.composing) this.commitInput(); }));
		this.listen(input.inputElement, 'compositionstart', () => { this.composing = true; }, false, this.inputLifetime);
		this.listen(input.inputElement, 'compositionend', () => {
			this.composing = false;
			queueMicrotask(() => { if (!this.isDisposed) { this.commitInput(); this.updateButtons(); this.flush(); } });
		}, false, this.inputLifetime);
		input.focus(); input.select({ start: input.value.length, end: input.value.length });
	}

	commitInput() {
		if (!this.active || this.composing || this.updating) return;
		const { start, end, input } = this.active;
		const edit = inputEdit(this.text.slice(start, end), input.value);
		if (edit.start === edit.end && !edit.text) return;
		this.text = this.text.slice(0, start + edit.start) + edit.text + this.text.slice(start + edit.end);
		this.active.end += edit.text.length - (edit.end - edit.start); this.flush();
	}

	patch(start, end, value) { this.text = this.text.slice(0, start) + value + this.text.slice(end); this.flush(); }

	selection() {
		if (!this.active) this.activate(0, this.text.length, true);
		if (!this.active) return;
		const { start, end, input } = this.active;
		const source = this.text.slice(start, end);
		return { start: start + sourceOffset(source, input.inputElement.selectionStart), end: start + sourceOffset(source, input.inputElement.selectionEnd) };
	}

	replace(value, selection = this.selection()) {
		if (!selection || this.readOnly || this.conflict || this.composing) return;
		this.patch(selection.start, selection.end, value);
		this.active.end += value.length - (selection.end - selection.start);
		this.updating = true; this.active.input.value = this.text.slice(this.active.start, this.active.end); this.updating = false;
		const caret = normalizedOffset(this.text.slice(this.active.start, this.active.end), selection.start - this.active.start + value.length);
		this.active.input.select({ start: caret, end: caret }); this.focus();
	}

	wrap(marker) {
		const selection = this.selection(); if (!selection) return;
		const selected = this.text.slice(selection.start, selection.end);
		const surrounded = this.text.slice(selection.start - marker.length, selection.start) === marker && this.text.slice(selection.end, selection.end + marker.length) === marker;
		this.replace(surrounded ? selected : marker + selected + marker, surrounded ? { start: selection.start - marker.length, end: selection.end + marker.length } : selection);
		const start = normalizedOffset(this.text.slice(this.active.start, this.active.end), selection.start - this.active.start + (surrounded ? -marker.length : marker.length));
		this.active.input.select({ start, end: start + selected.replace(/\r\n?/gu, '\n').length });
	}

	prefix(marker) {
		const selection = this.selection(); if (!selection) return;
		const start = this.text.lastIndexOf('\n', selection.start - 1) + 1;
		const end = this.text.indexOf('\n', Math.max(selection.start, selection.end - 1));
		const text = this.text.slice(start, end === -1 ? this.text.length : end);
		const lines = text.split('\n');
		const remove = lines.every(line => line.startsWith(marker));
		const replacement = lines.map(line => {
			const existing = marker === '# ' ? /^#{1,6} /u.exec(line)?.[0] : line.startsWith(marker) ? marker : '';
			return (remove ? '' : marker) + line.slice(existing?.length ?? 0);
		}).join('\n');
		this.replace(replacement, { start, end: start + text.length });
	}

	openLinkForm() {
		const selection = this.selection(); if (!selection) return;
		this.linkLabel = this.text.slice(selection.start, selection.end);
		this.form.hidden = false; this.url.value = ''; this.url.focus();
	}

	finish() {
		if (this.composing) return;
		this.commitInput(); const start = this.active?.start ?? 0; this.render();
		this.api.postMessage({ type: 'ready' });
		([...this.view.children].find(element => Number(element.dataset.start) >= start && element.tabIndex === 0) ?? this.view).focus();
	}

	focus() { if (this.active) this.active.input.focus(); else this.view.focus(); }

	keydown(event) {
		if (event.isComposing || this.composing || event.keyCode === 229) return;
		if (event.altKey && event.key === 'F10') { event.preventDefault(); event.stopImmediatePropagation(); this.buttons.find(button => !button.disabled && !button.hidden)?.focus(); return; }
		if (event.key === 'Escape') {
			event.preventDefault(); event.stopImmediatePropagation(); this.form.hidden = true;
			if (this.toolbar.contains(event.target) || this.form.contains(event.target)) this.focus(); else this.finish();
			return;
		}
		if ((event.key === 'Enter' || event.key === 'F2') && event.target.classList.contains('ash-markdown-block')) {
			event.preventDefault(); this.activate(Number(event.target.dataset.start), Number(event.target.dataset.end)); return;
		}
		if (!(event.ctrlKey || event.metaKey) || event.target === this.url) return;
		const key = event.key.toLowerCase();
		if (!['s', 'z', 'y', 'b', 'i', 'home', 'end'].includes(key)) return;
		event.preventDefault(); event.stopImmediatePropagation();
		if (key === 's') { this.commitInput(); this.saving = true; this.flush(); }
		else if (key === 'z' || key === 'y') this.history(event.shiftKey || key === 'y' ? 'redo' : 'undo');
		else if (key === 'b' || key === 'i') this.wrap(key === 'b' ? '**' : '*');
		else {
			this.activate(0, this.text.length, true);
			if (this.active) {
				const input = this.active.input.inputElement; const offset = key === 'home' ? 0 : input.value.length;
				input.setSelectionRange(event.shiftKey ? input.selectionStart : offset, offset);
			}
		}
	}

	flush() {
		if (this.composing || this.pending !== undefined || this.historyPending || this.conflict) return;
		if (this.text !== this.confirmed) {
			this.pending = this.text;
			this.api.postMessage({ type: 'edit', version: this.version, ...textEdit(this.confirmed, this.text) });
		} else if (this.historyQueue.length) {
			this.historyPending = true; this.api.postMessage({ type: this.historyQueue.shift(), version: this.version });
		} else if (this.saving) { this.saving = false; this.api.postMessage({ type: 'save' }); }
	}

	history(type) {
		if (this.readOnly || this.conflict || this.composing) return;
		this.commitInput(); this.historyQueue.push(type); this.flush();
	}

	adopt(snapshot) {
		if (!snapshot || this.composing) return;
		const focused = document.activeElement;
		const previous = this.active && { start: this.active.start, whole: this.active.whole, caret: this.active.input.inputElement.selectionStart };
		this.pending = undefined; this.conflict = false;
		this.version = snapshot.version; this.text = this.confirmed = snapshot.text; this.readOnly = snapshot.readOnly;
		this.status.textContent = ''; this.reload.hidden = true; this.render();
		if (previous && !this.readOnly) {
			const block = this.blocks.find(block => block.start <= previous.start && previous.start < block.end) ?? this.blocks.at(-1);
			this.activate(block.start, block.end, previous.whole);
			if (this.active) this.active.input.select({ start: Math.min(previous.caret, this.active.input.value.length), end: Math.min(previous.caret, this.active.input.value.length) });
		}
		// A delayed history response must not steal focus from the toolbar or link form.
		if (focused?.isConnected && focused !== document.body) focused.focus();
	}

	reject(message) {
		this.pending = undefined; this.saving = false; this.conflict = true; this.historyPending = false; this.historyQueue = [];
		if (message.document) this.latest = message.document;
		this.status.textContent = message.reason === 'readonly' ? this.messages.readonly : this.messages.conflict;
		this.reload.hidden = false; this.updateButtons();
	}

	receive(message) {
		if (!message || typeof message !== 'object') return;
		if (message.type === 'theme' && typeof message.variables === 'string') { document.documentElement.style.cssText = message.variables; return; }
		if (message.type === 'editRejected') { this.reject(message); return; }
		if (!Number.isSafeInteger(message.version) || message.version < this.version) return;
		if (message.type === 'accepted' && !this.conflict) {
			if (this.pending === undefined) return;
			this.confirmed = this.pending; this.pending = undefined; this.version = message.version;
			this.flush();
		} else if (message.type === 'document' && typeof message.text === 'string') {
			this.latest = message; this.historyPending = false;
			this.parsed = message;
			if (message.version === this.version && message.text === this.confirmed) {
				if (!this.active && !this.composing && !this.conflict && this.text === message.text) { this.status.textContent = ''; this.render(); }
				this.readOnly = message.readOnly; this.updateButtons(); this.flush();
			} else if (this.pending !== undefined || this.text !== this.confirmed || this.composing) this.reject({ reason: 'conflict', document: message });
			else { this.adopt(message); this.flush(); }
		}
	}
}

const initial = JSON.parse(document.getElementById('ash-markdown-initial').textContent);
const editor = new MarkdownEditor(initial);
