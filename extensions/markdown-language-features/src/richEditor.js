import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { normalizeTextToEOL } from '../../../src/ash/editor/common/core/misc/eolCounter.js';
import '../../markdown-math/src/styles.js';
import { createEmbeddedEditor, updateTaskProgress } from './embeddedEditor.js';
import { draftBlocks, mappedText, readSelection, rebaseSelection, restoreSelection } from './inlineEditing.js';
import { textEdit } from './sourceEdits.js';
import '../media/richEditor.css';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function documentEOL({ eol, text }) {
	if (eol === '\r\n' || eol === '\n') return eol;
	return text.includes('\r\n') ? '\r\n' : '\n';
}

/** A transient view and draft. The existing host owns versions, undo and saving. */
class MarkdownEditor extends Disposable {
	constructor(initial) {
		super();
		this.api = acquireVsCodeApi();
		this.messages = initial.messages;
		this.text = this.confirmed = initial.text;
		this.eol = documentEOL(initial);
		this.version = initial.version;
		this.latest = initial;
		this.parsed = initial;
		this.readOnly = initial.readOnly !== false;
		this.historyQueue = [];
		this.historyPending = false;
		this.saving = this.conflict = false;
		this.composition = undefined;
		this.pending = undefined;
		this.correction = undefined;
		this.submittedForms = new WeakSet();
		this._register(toDisposable(() => { for (const entry of this.renderedBlocks ?? []) entry.lifetime.dispose(); }));
		this.notice = document.createElement('div');
		this.notice.className = 'ash-markdown-notice';
		this.notice.hidden = true;
		this.status = document.createElement('div');
		this.status.className = 'ash-markdown-status';
		this.status.setAttribute('role', 'status');
		this.reload = document.createElement('button');
		this.reload.type = 'button';
		this.reload.textContent = this.messages.reload;
		this.notice.append(this.status, this.reload);
		this.listen(this.reload, 'click', () => this.adopt(this.latest));
		this.view = document.createElement('div');
		this.view.className = 'ash-markdown-content';
		this.view.tabIndex = 0;
		this.view.setAttribute('role', 'textbox');
		this.view.setAttribute('aria-multiline', 'true');
		this.view.setAttribute('aria-label', this.messages.editor);
		const main = document.createElement('main');
		main.className = 'ash-markdown-main'; main.append(this.view);
		document.body.append(this.notice, main);
		this.listen(document, 'keydown', event => this.keydown(event), true);
		this.listen(this.view, 'beforeinput', event => this.beforeInput(event));
		this.listen(this.view, 'paste', event => this.paste(event));
		this.listen(this.view, 'compositionstart', event => this.startComposition(event));
		this.listen(this.view, 'compositionend', event => this.endComposition(event));
		this.listen(this.view, 'click', event => {
			const anchor = event.target.closest('a');
			if (!anchor) return;
			event.preventDefault();
			if (this.readOnly || this.conflict || event.ctrlKey || event.metaKey || event.detail === 0) {
				this.api.postMessage({ href: anchor.getAttribute('href') });
			}
		});
		this.listen(window, 'message', event => { if (event.source === parent) this.receive(event.data); });
		this.listen(window, 'pagehide', () => this.dispose());
		this.render();
		this.api.postMessage({ type: 'ready' });
	}

	listen(target, type, listener, capture = false, store) {
		const disposable = addDisposableListener(target, type, listener, capture);
		if (store) store.add(disposable); else this._register(disposable);
	}

	updateEditability() {
		const editable = !this.readOnly && !this.conflict;
		this.view.contentEditable = String(editable || Boolean(this.composition));
		this.view.setAttribute('aria-readonly', String(!editable));
		this.notice.hidden = !this.status.textContent;
		this.reload.hidden = !this.conflict;
		for (const checkbox of this.view.querySelectorAll('input[type=checkbox]')) checkbox.disabled = !editable;
		for (const fieldset of this.view.querySelectorAll('.ash-markdown-json-form fieldset')) fieldset.disabled = !editable;
	}

	render(selection, invalidated) {
		const focused = document.activeElement;
		const focusedBlock = focused?.closest('.ash-markdown-embedded')?.closest('.ash-markdown-block');
		if (!selection && focused === this.view) {
			const previous = this.renderedText ?? this.text;
			selection = rebaseSelection(readSelection(this.view, previous), previous, this.text);
		}
		const current = this.parsed?.text === this.text;
		const blocks = draftBlocks(this.parsed, this.text);
		if (current && this.parsed.parseError && !this.conflict) this.status.textContent = this.messages.parseError;
		const reusable = new Map();
		for (const entry of this.renderedBlocks ?? []) {
			if (invalidated?.has(entry.element) || this.submittedForms.has(entry.element)) continue;
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
				element.classList.add('ash-markdown-gap');
				const gap = mappedText(document.createElement('span'), source.replace(/\r\n?/gu, '\n'), [0, source.length]);
				// Keep an editable position on blank lines so queued typing after
				// Enter cannot jump across them into the next block.
				if (gap.textContent.endsWith('\n')) gap.append(document.createElement('br'));
				element.append(gap);
			} else {
				const content = block.content[0] === 'embedded'
					? createEmbeddedEditor(block.content[1], source, this.messages, lifetime, replacement => this.applyEmbeddedEdit(element, source, replacement))
					: this.node(block.content, false, lifetime);
				if (block.content[0] === 'embedded') content.contentEditable = 'false';
				element.append(content);
			}
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
		this.renderedText = this.text;
		if (this.parsed?.taskProgress) updateTaskProgress(this.view, this.parsed.taskProgress, this.messages);
		this.updateEditability();
		if (selection) restoreSelection(this.view, this.text, selection);
		if (focusedBlock && !focused.isConnected) {
			const block = this.renderedBlocks.find(({ element }) => element.dataset.start === focusedBlock.dataset.start)?.element;
			(block?.querySelector('.ash-markdown-json-form fieldset:not(:disabled) button') ?? this.view).focus();
		}
	}

	applyEmbeddedEdit(element, source, replacement) {
		if (this.readOnly || this.conflict || this.composition || !element.isConnected) return;
		const start = Number(element.dataset.start);
		// A control rendered from an older snapshot must never patch a different block.
		if (this.text.slice(start, start + source.length) !== source) return;
		const edit = textEdit(source, replacement);
		// An undo may return the old source before the edited snapshot is
		// rendered. Recreate the controls from the source in either case.
		this.submittedForms.add(element);
		this.patch(start + edit.start, start + edit.end, edit.text);
	}

	node([kind, value, detail, html], header = false, lifetime) {
		const children = (parent, nodes) => { for (const child of nodes) parent.append(this.node(child, header, lifetime)); return parent; };
		switch (kind) {
			case 't': return mappedText(document.createElement('span'), value, detail);
			case 'raw': {
				const span = mappedText(document.createElement('span'), value, detail);
				span.className = 'ash-markdown-raw';
				return span;
			}
			case 'code': return mappedText(document.createElement('code'), value, detail);
			case 'br': return document.createElement('br');
			case 'hr': return document.createElement('hr');
			case 'math': {
				const element = document.createElement('span');
				element.contentEditable = 'false';
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
				const image = document.createElement('img'); image.alt = label; image.src = value; image.contentEditable = 'false'; return image;
			}
			case 'task': {
				const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = value;
				checkbox.contentEditable = 'false';
				checkbox.disabled = this.readOnly || this.conflict; checkbox.setAttribute('aria-label', this.messages.task);
				this.listen(checkbox, 'change', () => {
					const offset = Number(checkbox.closest('.ash-markdown-block')?.dataset.start) + detail;
					if (this.readOnly || this.conflict || this.composition || !/^\[[ xX]\]$/u.test(this.text.slice(offset, offset + 3))) return;
					this.patch(offset + 1, offset + 2, checkbox.checked ? 'x' : ' ');
					this.render();
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

	patch(start, end, value) {
		this.text = this.text.slice(0, start) + value + this.text.slice(end);
		this.flush();
	}

	get editable() { return !this.readOnly && !this.conflict && !this.composition; }

	replace(value, { start, end }, cursor, invalidated) {
		value = normalizeTextToEOL(value, this.eol);
		if (start !== end || value) this.patch(start, end, value);
		const caret = start + value.length;
		this.render(cursor ?? { anchor: caret, focus: caret }, invalidated);
	}

	paste(event) {
		if (event.target.closest('.ash-markdown-embedded')) return;
		event.preventDefault();
		if (!this.editable) return;
		const selection = this.selection();
		const value = event.clipboardData?.getData('text/plain');
		if (selection && value) this.replace(value, selection);
	}

	selection(target) {
		const selection = readSelection(this.view, this.text, target);
		if (selection) return {
			start: Math.min(selection.anchor, selection.focus),
			end: Math.max(selection.anchor, selection.focus),
		};
	}

	beforeInput(event) {
		if (event.target !== this.view || event.isComposing || this.composition) return;
		event.preventDefault();
		if (!this.editable) return;
		const type = event.inputType;
		if (type === 'historyUndo' || type === 'historyRedo') {
			this.history(type === 'historyUndo' ? 'undo' : 'redo');
			return;
		}
		const target = event.getTargetRanges?.()[0];
		const selection = this.selection(target) ?? this.selection();
		if (!selection) return;
		if (type.startsWith('delete')) {
			const { start, end } = selection;
			if (start === end) {
				const backward = type.endsWith('Backward');
				if (!backward && !type.endsWith('Forward')) return;
				const segment = graphemes.segment(this.text).containing(backward ? start - 1 : end);
				if (!segment) return;
				this.replace('', { start: segment.index, end: segment.index + segment.segment.length });
			} else this.replace('', selection);
			return;
		}
		if (type === 'insertParagraph' || type === 'insertLineBreak') {
			const element = document.getSelection().anchorNode?.parentElement;
			if (element?.closest('td, th')) return;
			const newline = element?.closest('pre') ? '\n'
				: type === 'insertLineBreak' ? '  \n' : this.paragraphBreak(selection.start, element);
			this.replace(newline, selection);
			return;
		}
		if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromDrop') {
			const value = event.data ?? event.dataTransfer?.getData('text/plain');
			if (value) this.replace(value, selection);
		}
	}

	paragraphBreak(offset, element) {
		if (!element?.closest('li')) return '\n\n';
		const line = this.text.slice(this.text.lastIndexOf('\n', offset - 1) + 1, offset);
		const marker = /^(\s*)([-+*]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/u.exec(line);
		if (!marker) return '\n\n';
		const [, indent, bullet, task] = marker;
		const next = bullet.length === 1 ? bullet : String(Number.parseInt(bullet, 10) + 1) + bullet.at(-1);
		return '\n' + indent + next + ' ' + (task ? '[ ] ' : '');
	}

	startComposition(event) {
		if (event.target !== this.view || !this.editable) return;
		const selection = this.selection();
		if (!selection) return;
		// Chromium owns the provisional IME text. Replace any mutated DOM when
		// the composition settles, even when its final source is unchanged.
		const blocks = new Set([...this.view.children].filter(element =>
			Number(element.dataset.start) <= selection.end && Number(element.dataset.end) >= selection.start));
		this.composition = { selection, blocks };
	}

	endComposition(event) {
		const composition = this.composition;
		if (event.target !== this.view || !composition) return;
		queueMicrotask(() => {
			if (this.isDisposed) return;
			this.composition = undefined;
			if (this.conflict || this.readOnly) {
				this.uncommittedBlocks = composition.blocks;
				this.updateEditability();
				return;
			}
			if (event.data) this.replace(event.data, composition.selection, undefined, composition.blocks);
			else {
				const { start, end } = composition.selection;
				this.render({ anchor: start, focus: end }, composition.blocks);
				this.flush();
			}
		});
	}

	wrap(marker) {
		const selection = this.selection();
		if (!selection || selection.start === selection.end) return;
		const { start, end } = selection;
		const text = this.text.slice(start, end);
		const surrounded = this.text.slice(start - marker.length, start) === marker
			&& this.text.slice(end, end + marker.length) === marker;
		const anchor = start + (surrounded ? -marker.length : marker.length);
		const range = surrounded ? { start: start - marker.length, end: end + marker.length } : selection;
		this.replace(surrounded ? text : marker + text + marker, range, { anchor, focus: anchor + text.length });
	}

	keydown(event) {
		if (event.isComposing || this.composition || event.keyCode === 229 || !(event.ctrlKey || event.metaKey)) return;
		const key = event.key.toLowerCase();
		if (key !== 's' && event.target.closest('.ash-markdown-embedded input[type=text]')) return;
		if (!['s', 'z', 'y', 'b', 'i'].includes(key)) return;
		event.preventDefault(); event.stopImmediatePropagation();
		if (key === 's') { this.saving = true; this.flush(); }
		else if (key === 'z' || key === 'y') this.history(event.shiftKey || key === 'y' ? 'redo' : 'undo');
		else if (this.editable) this.wrap(key === 'b' ? '**' : '*');
	}

	flush() {
		if (this.composition || this.pending !== undefined || this.historyPending || this.conflict) return;
		if (this.correction !== undefined) {
			const submitted = this.correction;
			this.correction = undefined;
			if (normalizeTextToEOL(submitted, this.eol) === this.confirmed) {
				// Rebase queued edits if the model chose a different line ending.
				const normalized = normalizeTextToEOL(this.text, this.eol);
				if (normalized !== this.text) {
					this.text = normalized;
					this.render();
				}
			} else if (this.text === submitted) {
				this.adopt(this.latest);
			} else {
				this.reject({ reason: 'conflict' });
				return;
			}
		}
		if (this.text !== this.confirmed) {
			this.pending = this.text;
			this.api.postMessage({ type: 'edit', version: this.version, ...textEdit(this.confirmed, this.text) });
		} else if (this.historyQueue.length) {
			this.historyPending = true; this.api.postMessage({ type: this.historyQueue.shift(), version: this.version });
		} else if (this.saving) { this.saving = false; this.api.postMessage({ type: 'save' }); }
	}

	history(type) {
		if (!this.editable) return;
		this.historyQueue.push(type);
		this.flush();
	}

	adopt(snapshot) {
		if (!snapshot || this.composition) return;
		this.pending = this.correction = undefined; this.conflict = false;
		this.version = snapshot.version; this.text = this.confirmed = snapshot.text; this.readOnly = snapshot.readOnly;
		this.eol = documentEOL(snapshot);
		this.status.textContent = '';
		this.render(undefined, this.uncommittedBlocks);
		this.uncommittedBlocks = undefined;
	}
	reject(message) {
		this.pending = this.correction = undefined; this.saving = false; this.conflict = true; this.historyPending = false; this.historyQueue = [];
		if (message.document) this.latest = message.document;
		this.status.textContent = message.reason === 'readonly' ? this.messages.readonly : this.messages.conflict;
		this.updateEditability();
	}

	receive(message) {
		if (!message || typeof message !== 'object') return;
		if (message.type === 'theme' && typeof message.variables === 'string') { document.documentElement.style.cssText = message.variables; return; }
		if (message.type === 'editRejected') { this.reject(message); return; }
		if (!Number.isSafeInteger(message.version) || message.version < this.version) return;
		if (message.type === 'accepted' && !this.conflict) {
			if (this.pending === undefined) return;
			this.confirmed = typeof message.text === 'string' ? message.text : this.pending;
			this.version = message.version;
			if (this.confirmed !== this.pending) {
				this.eol = documentEOL({ eol: message.eol, text: this.confirmed });
				this.latest = { version: this.version, text: this.confirmed, eol: this.eol, readOnly: this.readOnly };
				this.correction = this.pending;
			}
			this.pending = undefined;
			this.flush();
		} else if (message.type === 'document' && typeof message.text === 'string') {
			this.latest = message; this.historyPending = false;
			this.parsed = message;
			if (message.version === this.version && message.text === this.confirmed) {
				this.eol = documentEOL(message);
				this.readOnly = message.readOnly;
				if (!this.conflict && this.text === message.text) {
					if (!this.composition) { this.status.textContent = ''; this.render(); }
					else if (message.taskProgress) updateTaskProgress(this.view, message.taskProgress, this.messages);
				}
				this.updateEditability();
				this.flush();
			} else if (this.pending !== undefined || this.text !== this.confirmed || this.composition) this.reject({ reason: 'conflict', document: message });
			else { this.adopt(message); this.flush(); }
		}
	}
}

const initial = JSON.parse(document.getElementById('ash-markdown-initial').textContent);
const editor = new MarkdownEditor(initial);
