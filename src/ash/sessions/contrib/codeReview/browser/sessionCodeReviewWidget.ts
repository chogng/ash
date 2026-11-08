import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { posix } from '../../../../base/common/path.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ReviewZoneWidget } from '../../../../workbench/contrib/comments/browser/commentThreadZoneWidget.js';
import type { MultiDiffEditor } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { createMultiDiffEditorInput, multiDiffEditorItemKey, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import {
	ISessionCodeReviewService, codeReviewFilePath, codeReviewRepositoryId, codeReviewResource, type CodeReviewComment, type CodeReviewDraft, type CodeReviewTarget, type SessionCodeReviewService,
} from './sessionCodeReviewService.js';
import './media/sessionCodeReview.css';

export interface CodeReviewComparison {
	readonly target: CodeReviewTarget;
	readonly history?: string;
	readonly isCurrent: () => boolean;
	readonly navigationRevision: () => number;
}

export class SessionCodeReviewWidget extends Disposable {
	private readonly mounted = this._register(new DisposableMap<DiffEditorWidget, MountedCodeReview>());
	// Inline zones can be rebuilt or recycled while this comparison is still open.
	private readonly edits = new Map<string, { readonly start: number; readonly text: string; }>();
	private activeZone: ReviewZoneWidget | undefined;
	private readonly sendButton: HTMLButtonElement;
	private readonly notes: HTMLElement;
	private readonly noteListeners = this._register(new DisposableStore());
	private noteVersion = '';
	private readonly status: HTMLElement;
	private comparison: CodeReviewComparison | undefined;

	constructor(
		public readonly element: HTMLElement,
		private readonly reveal: (comment: CodeReviewComment) => boolean,
		private readonly openComparison: ((resource: URI) => Promise<void>) | undefined,
		@ISessionCodeReviewService private readonly reviews: SessionCodeReviewService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const document = element.ownerDocument;
		element.classList.add('ash-session-code-review');
		element.setAttribute('role', 'region');
		element.setAttribute('aria-label', localize('sessions.codeReview.title', 'Code Review'));
		const icon = h(document, 'span');
		appendIcon(Lxicon.comment, icon);
		const heading = h(document, 'header', { className: 'ash-session-code-review-notes-header' },
			icon, h(document, 'h3', localize('sessions.codeReview.comments', 'Review comments')));
		this.notes = h(document, 'div', { className: 'ash-session-code-review-notes' });
		this.sendButton = button(document, localize('sessions.bots.sendReview', 'Send to Code Review'), 'secondary');
		this.status = h(document, 'span', { className: 'ash-session-code-review-status', attributes: { role: 'status' } });
		const footer = h(document, 'footer', { className: 'ash-session-code-review-footer' }, this.status, this.sendButton);
		element.append(heading, this.notes, footer);
		this._register(addDisposableListener(this.sendButton, 'click', () => {
			const comparison = this.comparison;
			if (!comparison) return;
			const navigation = comparison.navigationRevision();
			void this.reviews.send(comparison.target, () => this.comparison === comparison && comparison.navigationRevision() === navigation && comparison.isCurrent())
				.catch(error => this.notifications.error(error));
		}));
		this._register(reviews.onDidChange(key => {
			if (this.comparison && reviews.affects(this.comparison.target, key)) this.refresh();
		}));
		this.refresh();
	}

	public setComparison(comparison: CodeReviewComparison | undefined): void {
		this.closeComment();
		this.edits.clear();
		this.noteVersion = '';
		this.comparison = comparison;
		this.refresh();
	}

	public closeComment(): void {
		this.activeZone?.close();
		this.activeZone = undefined;
	}

	public snapshot(comparison = this.comparison): CodeReviewDraft | undefined {
		if (!comparison) return undefined;
		const { target, history } = comparison;
		if (history === 'draft') return this.reviews.draft(target);
		if (history) return this.reviews.batch(target, history);
		return this.reviews.draft(target);
	}

	public attach(item: MultiDiffEditorInputItem, editor: DiffEditorWidget, turnRepositories?: ReadonlyMap<string, string>): IDisposable | undefined {
		const comparison = this.comparison;
		if (!comparison || item.binary) return undefined;
		const resources = new DisposableStore();
		const fileKey = multiDiffEditorItemKey(item);
		const path = codeReviewFilePath(item.modified.resource);
		const repositoryId = codeReviewRepositoryId(item.modified.resource, turnRepositories);
		editor.updateOptions({ glyphMargin: true });
		const createZone = (side: CodeReviewComment['side'], control: ICodeEditor, peer: ICodeEditor) => {
			let opening: { readonly start: number; readonly end: number; readonly initial: string; } | undefined;
			const canAdd = () => !comparison.history && comparison.isCurrent() && !!control.getModel() && item[side].initialText !== '';
			const matches = (comment: CodeReviewComment, line: number) => comment.file === fileKey && comment.side === side && (comment.endLine ?? comment.line) === line;
			const draftAt = (line: number) => this.snapshot(comparison)?.comments.find(comment => matches(comment, line));
			const editKey = (line: number) => JSON.stringify([fileKey, side, line]);
			const zone = resources.add(new ReviewZoneWidget(control, {
				canAdd,
				getTitle: line => {
					const start = this.edits.get(editKey(line))?.start ?? draftAt(line)?.line ?? opening?.start;
					return start !== undefined && start < line
						? localize('sessions.codeReview.rangeComments', 'Comments on lines {0}–{1}', start, line) : undefined;
				},
				onOpen: () => {
					this.activeZone?.close();
					this.activeZone = zone;
				},
				comparison: { editor: peer, original: side === 'original', rows: () => editor.viewMode === 'sideBySide' ? editor.diff?.rows : undefined },
				render: (line, body, listeners) => {
					const comment = draftAt(line);
					if (!comparison.history) {
						const sent = this.reviews.batches(comparison.target).filter(batch => !batch.pending).flatMap(batch => batch.comments.filter(comment => matches(comment, line)));
						for (const entry of sent) body.append(h(body.ownerDocument, 'p', { className: 'ash-session-code-review-comment' }, entry.text));
					}
					const key = editKey(line);
					const edit = this.edits.get(key);
					const start = edit?.start ?? comment?.line ?? opening?.start ?? line;
					const endLine = start < line ? line : undefined;
					const text = edit?.text ?? comment?.text ?? opening?.initial ?? '';
					if (!edit && !comment && text) {
						this.edits.set(key, { start, text });
					}
					return this.renderComment(comparison, body, listeners, comment, text, value => {
						this.edits.set(key, { start, text: value });
					}, () => {
						this.edits.delete(key);
					}, value => {
						this.reviews.save(comparison.target, {
							key: fileKey, path: item.id && comparison.history ? item.label : path || item.label,
							repositoryId,
							before: editor.originalEditor.getModel()?.getValue() ?? '',
							after: editor.modifiedEditor.getModel()?.getValue() ?? '',
						}, { side, line: start, endLine }, value);
					});
				},
			}));
			resources.add(control.onKeyDown(event => {
				if (event.isComposing || event.repeat) return;
				const selection = control.getSelection();
				if (!selection) return;
				const shortcut = event.matches({ code: 'KeyM', altKey: true, ctrlKey: !isMacintosh, metaKey: isMacintosh });
				const typing = !selection.isEmpty() && canAdd() && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
				if (!shortcut && !typing) return;
				const start = selection.startLineNumber;
				const end = Math.max(start, selection.endLineNumber - Number(selection.endColumn === 1));
				opening = { start, end, initial: typing ? event.key : '' };
				try {
					if (zone.show(opening.end, true)) event.stop({ preventDefault: true });
				} finally {
					opening = undefined;
				}
			}));
			return zone;
		};
		const original = createZone('original', editor.originalEditor, editor.modifiedEditor);
		const modified = createZone('modified', editor.modifiedEditor, editor.originalEditor);
		const entry = Object.assign(toDisposable(() => {
			if (this.activeZone === original || this.activeZone === modified) this.activeZone = undefined;
			resources.dispose();
		}), { fileKey, original, modified, comments: undefined });
		this.mounted.set(editor, entry);
		this.updateMarkers(entry);
		return toDisposable(() => this.mounted.deleteAndDispose(editor));
	}

	public show(comment: CodeReviewComment, pane: MultiDiffEditor, comparison: MultiDiffEditorInput): boolean {
		const item = comparison.items.find(item => multiDiffEditorItemKey(item) === comment.file);
		if (!item) return false;
		pane.reveal({ original: item.original.resource, modified: item.modified.resource }, {
			range: new Range(comment.line, 1, comment.endLine ?? comment.line, 1),
			side: comment.side,
			highlight: true,
			onRevealed: editor => this.mounted.get(editor)?.[comment.side].show(comment.endLine ?? comment.line),
		});
		return true;
	}

	public refresh(): void {
		const comparison = this.comparison;
		this.element.hidden = !comparison;
		if (!comparison) return;
		const snapshot = this.snapshot(comparison);
		const pending = comparison.history ? undefined : this.reviews.pending(comparison.target);
		const count = snapshot?.comments.length ?? 0;
		const sending = this.reviews.isSending(comparison.target);
		this.sendButton.hidden = !!comparison.history;
		this.sendButton.disabled = sending || !comparison.isCurrent() || !count && !pending;
		this.sendButton.textContent = pending && !sending
			? localize('sessions.codeReview.retry', 'Confirm or Retry Send')
			: localize('sessions.bots.sendReview', 'Send to Code Review');
		this.status.textContent = sending ? localize('sessions.codeReview.sending', 'Sending review…')
			: pending ? localize('sessions.codeReview.unconfirmed', 'Review submission unconfirmed')
				: comparison.history ? localize('sessions.codeReview.snapshot', '{0} comments · Saved comparison', count)
					: localize('sessions.codeReview.drafts', '{0} draft comments', count);
		this.renderNotes(comparison, snapshot);
		for (const [, entry] of this.mounted) this.updateMarkers(entry);
	}

	private updateMarkers(entry: MountedCodeReview): void {
		const comparison = this.comparison;
		const comments = comparison ? [
			...(this.snapshot(comparison)?.comments ?? []),
			...(!comparison.history ? this.reviews.batches(comparison.target).filter(batch => !batch.pending).flatMap(batch => batch.comments) : []),
		].filter(comment => comment.file === entry.fileKey) : [];
		const revision = JSON.stringify([comparison?.isCurrent(), comments]);
		if (entry.comments === revision) return;
		entry.comments = revision;
		for (const side of ['original', 'modified'] as const) {
			entry[side].update(new Set(comments.filter(comment => comment.side === side).map(comment => comment.endLine ?? comment.line)));
		}
	}

	private renderNotes(comparison: CodeReviewComparison, snapshot: CodeReviewDraft | undefined): void {
		const draft = snapshot ? [{
			snapshot, history: comparison.history, title: comparison.history && comparison.history !== 'draft'
				? localize('sessions.codeReview.saved', 'Saved comments') : localize('sessions.codeReview.pendingNotes', 'Drafts')
		}] : [];
		const history = comparison.history ? [] : this.reviews.batches(comparison.target).slice().reverse().map(batch => ({
			snapshot: batch, history: batch.id, title: batch.pending ? localize('sessions.codeReview.unconfirmed', 'Review submission unconfirmed')
				: localize('sessions.codeReview.previous', 'Previous review'),
		}));
		const groups = [...draft, ...history].filter(group => group.snapshot.comments.length);
		const version = JSON.stringify(groups.map(group => [group.history, group.title, group.snapshot.comments]));
		if (version === this.noteVersion) return;
		this.noteVersion = version;
		const document = this.element.ownerDocument;
		const focused = document.activeElement?.getAttribute('data-review-note');
		this.noteListeners.clear();
		this.notes.replaceChildren();
		if (!groups.length) {
			this.notes.append(h(document, 'p', { className: 'ash-session-code-review-note-empty' },
				localize('sessions.codeReview.noteHint', 'Select code and start typing to leave a comment.')));
		}
		for (const group of groups) {
			const section = h(document, 'section', { className: 'ash-session-code-review-note-group' }, h(document, 'h4', group.title));
			const list = h(document, 'ul');
			for (const [index, comment] of group.snapshot.comments.entries()) {
				const path = group.snapshot.files.find(file => file.key === comment.file)?.path ?? '';
				const name = posix.basename(path);
				const location = comment.endLine
					? localize('sessions.codeReview.rangeLocation', '{0}. {1}, lines {2}–{3}', index + 1, name, comment.line, comment.endLine)
					: localize('sessions.codeReview.location', '{0}. {1}, line {2}', index + 1, name, comment.line);
				const note = h(document, 'button', {
					className: 'ash-session-code-review-note', properties: { type: 'button', title: path },
					attributes: { 'data-review-note': comment.id },
				}, h(document, 'span', { className: 'ash-session-code-review-note-location' }, location),
					h(document, 'span', { className: 'ash-session-code-review-note-body' }, comment.text));
				this.noteListeners.add(addDisposableListener(note, 'click', () => {
					void this.openNote(comparison, comment, group.history).catch(error => this.notifications.error(error));
				}));
				list.append(h(document, 'li', note));
			}
			section.append(list);
			this.notes.append(section);
		}
		if (focused) [...this.notes.querySelectorAll<HTMLButtonElement>('[data-review-note]')]
			.find(note => note.dataset.reviewNote === focused)?.focus({ preventScroll: true });
	}

	private async openNote(comparison: CodeReviewComparison, comment: CodeReviewComment, history?: string): Promise<void> {
		if (this.comparison !== comparison) return;
		if (history === comparison.history && this.reveal(comment)) return;
		const resource = codeReviewResource(comparison.target, history ?? 'draft').with({ fragment: comment.id });
		await (this.openComparison?.(resource) ?? this.editors.openEditor({ resource }, { pinned: true }));
	}

	private renderComment(comparison: CodeReviewComparison, body: HTMLElement, listeners: DisposableStore, comment: CodeReviewComment | undefined,
		text: string, edit: (text: string) => void, clearEdit: () => void, save: (text: string) => void): HTMLElement | undefined {
		const document = body.ownerDocument;
		if (comparison.history && comparison.history !== 'draft') {
			if (comment) body.append(h(document, 'p', { className: 'ash-session-code-review-comment' }, comment.text));
			return undefined;
		}
		const composer = h(document, 'textarea', {
			className: 'ash-session-code-review-input',
			properties: { value: text, rows: 1 },
			attributes: { 'aria-label': localize('sessions.codeReview.comment', 'Comment for the agent') },
		});
		const saveButton = button(document, localize('sessions.codeReview.save', 'Save Draft'), 'secondary');
		const actions = h(document, 'div', { className: 'ash-session-code-review-actions' }, saveButton);
		body.append(composer, actions);
		const update = () => { saveButton.disabled = !composer.value.trim() || !comparison.isCurrent(); };
		update();
		listeners.add(addDisposableListener(composer, 'input', () => {
			edit(composer.value);
			update();
		}));
		const submit = () => {
			if (saveButton.disabled) return;
			const value = composer.value;
			clearEdit();
			try {
				save(value.trim());
			} catch (error) {
				edit(value);
				this.notifications.error(error instanceof Error ? error : String(error));
				return;
			}
			// Saving rebuilds the inline body. Restore focus to the replacement composer.
			body.querySelector('textarea')?.focus();
		};
		listeners.add(addDisposableListener(saveButton, 'click', submit));
		listeners.add(addDisposableListener(composer, 'keydown', event => {
			if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			submit();
		}));
		if (comment) {
			const remove = button(document, localize('sessions.codeReview.remove', 'Delete Draft'), 'quiet');
			remove.disabled = !comparison.isCurrent();
			actions.append(remove);
			listeners.add(addDisposableListener(remove, 'click', () => {
				if (!comparison.isCurrent()) return;
				clearEdit();
				this.reviews.remove(comparison.target, comment.id);
				body.querySelector('textarea')?.focus();
			}));
		}
		return composer;
	}
}

interface MountedCodeReview extends IDisposable {
	readonly fileKey: string;
	readonly original: ReviewZoneWidget;
	readonly modified: ReviewZoneWidget;
	comments: string | undefined;
}

function button(document: Document, label: string, presentation: 'quiet' | 'secondary'): HTMLButtonElement {
	return h(document, 'button', { className: `ash-button ash-button-${presentation}`, properties: { type: 'button' } }, label);
}

export function createReviewSnapshot(resource: URI, snapshot: CodeReviewDraft): MultiDiffEditorInput {
	const label = localize('sessions.codeReview.title', 'Code Review');
	return createMultiDiffEditorInput(resource.with({ scheme: 'ash-multi-diff', fragment: '' }), snapshot.files.map((file, index) => {
		const side = (initialText: string, side: string) => ({
			resource: resource.with({ scheme: 'ash-code-review-file', path: `/${file.path}`, fragment: `${index}-${side}` }),
			initialText, readOnly: true,
		});
		return { id: file.key, label: file.path, original: side(file.before, 'before'), modified: side(file.after, 'after') };
	}), label, { kind: 'snapshot', label });
}
