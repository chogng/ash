import { generateUuid } from '../../../../../base/common/uuid.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../nls.js';
import { DOCS_COMMENTS_MAX_SOURCE_LENGTH, DocsCommentState, readDocsCommentEvent, writeDocsCommentEvent, type DocsCommentThread, type DocsCommentMessage, type DocsCommentEvent, type DocsCommentEventPayload } from '../../common/arkdownComments.js';
import type { ArkdownEdit, ArkdownNode, ArkdownRange, ArkdownRuntime } from './arkdownRuntime.js';

const maxEvents = 4096;

export interface DocsCommentDraft { readonly version: number; readonly range: ArkdownRange; readonly quote: string; }
export interface DocsCommentSnapshot {
	readonly version: number;
	readonly threads: readonly DocsCommentThread[];
	readonly anchors: ReadonlyMap<string, { readonly range: ArkdownRange; readonly quote: string; }>;
	readonly metadataRanges: readonly ArkdownRange[];
	readonly trailingMetadataStart?: number;
	readonly invalid: boolean;
}

/** A read-only projection and transaction adapter over the existing text model.
 * Each change appends a separate record, so concurrent replies never replace a
 * shared JSON array. Source marks, records and undo remain in the same buffer. */
export class ArkdownComments {
	private cached: { snapshot: DocsCommentSnapshot; nodes: readonly ArkdownNode[]; events: readonly DocsCommentEvent[]; } | undefined;
	constructor(private readonly model: TextModel, private readonly runtime: ArkdownRuntime,
		private readonly canEdit: () => boolean, private readonly getSelection: () => ArkdownRange, private readonly getNodes: () => readonly ArkdownNode[]) { }
	get isReadonly(): boolean { return !this.canEdit(); }
	get snapshot(): DocsCommentSnapshot {
		const version = this.model.getVersionId();
		if (this.cached?.snapshot.version === version) return this.cached.snapshot;
		const source = this.model.getValue();
		let nodes: readonly ArkdownNode[];
		try { nodes = this.getNodes(); }
		catch {
			const snapshot: DocsCommentSnapshot = { version, threads: [], anchors: new Map(), metadataRanges: [], invalid: true };
			this.cached = { snapshot, nodes: [], events: [] }; return snapshot;
		}
		const events = new Map<string, DocsCommentEvent>(), metadataRanges: ArkdownRange[] = [];
		let invalid = false, length = 0;
		for (const node of nodes) {
			if (node.kind !== 'code_block' || !/^\s*(?:`{3,}|~{3,})ash-comments(?:\s|$)/u.test(source.slice(node.range.start, node.range.end))) continue;
			length += node.range.end - node.range.start;
			const event = readDocsCommentEvent(source.slice(node.range.start, node.range.end));
			if (!event || length > DOCS_COMMENTS_MAX_SOURCE_LENGTH || events.size >= maxEvents) { invalid = true; continue; }
			const previous = events.get(event.id);
			if (previous && JSON.stringify(previous) !== JSON.stringify(event)) invalid = true;
			events.set(event.id, event); metadataRanges.push(node.range);
		}
		const ordered = [...events.values()].sort((a, b) => a.clock - b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const threads = new Map<string, DocsCommentThread>(), deleted = new Set<string>(), deletedMessages = new Set<string>();
		for (const event of ordered) {
			if (deleted.has(event.threadId)) continue;
			const thread = threads.get(event.threadId);
			switch (event.op) {
				case 'create':
					if (!thread) threads.set(event.threadId, { id: event.threadId, state: DocsCommentState.Open, quote: event.quote, messages: [event.message] });
					break;
				case 'reply':
					if (thread && !deletedMessages.has(event.message.id) && !thread.messages.some(message => message.id === event.message.id)) threads.set(thread.id, { ...thread, messages: [...thread.messages, event.message] });
					break;
				case 'edit':
					if (thread) threads.set(thread.id, { ...thread, messages: thread.messages.map(message => message.id === event.messageId ? { ...message, body: event.body, editedAt: Math.max(event.editedAt, message.createdAt) } : message) });
					break;
				case 'state': if (thread) threads.set(thread.id, { ...thread, state: event.state }); break;
				case 'delete_message':
					deletedMessages.add(event.messageId);
					if (thread) threads.set(thread.id, { ...thread, messages: thread.messages.filter(message => message.id !== event.messageId) });
					break;
				case 'delete_thread': deleted.add(event.threadId); threads.delete(event.threadId); break;
			}
		}
		const anchors = new Map<string, { range: ArkdownRange; quote: string; }>();
		const text = (node: ArkdownNode): string => node.text ?? node.children.map(text).join('');
		const visit = (node: ArkdownNode): void => {
			if (node.kind === 'comment' && node.threadId && threads.has(node.threadId)) {
				const quote = node.children.map(text).join('');
				if (quote.trim()) {
					const previous = anchors.get(node.threadId);
					const gap = previous && /\n/u.test(source.slice(previous.range.end, node.range.start)) ? '\n' : '';
					anchors.set(node.threadId, { range: { start: previous?.range.start ?? node.range.start, end: node.range.end }, quote: (previous?.quote ?? '') + gap + quote });
				}
			}
			for (const child of node.children) visit(child);
		};
		for (const node of nodes) visit(node);
		let trailingMetadataStart: number | undefined;
		for (const node of [...nodes].reverse()) {
			if (!metadataRanges.some(range => range.start === node.range.start)) break;
			trailingMetadataStart = node.range.start;
		}
		const snapshot: DocsCommentSnapshot = {
			version, threads: invalid ? [] : [...threads.values()].filter(thread => thread.messages.length), anchors,
			metadataRanges: invalid ? [] : metadataRanges, trailingMetadataStart: invalid ? undefined : trailingMetadataStart, invalid
		};
		this.cached = { snapshot, nodes, events: ordered }; return snapshot;
	}
	capture(range: ArkdownRange, quote: string): DocsCommentDraft | undefined {
		return quote.trim() && range.start !== range.end ? { version: this.snapshot.version, range: { ...range }, quote } : undefined;
	}
	create(body: string, authorId: string, draft?: DocsCommentDraft): string {
		const state = this.editable();
		if (draft && draft.version !== state.version) throw new Error(localize({ bundle: 'ash.docs', key: 'commentSelectionChanged' }, 'The document changed. Select the text again before adding this comment.'));
		const id = generateUuid(), edits: ArkdownEdit[] = [];
		let selection: ArkdownRange | undefined;
		if (draft) {
			const insertions = new Map<number, string>();
			const insert = (offset: number, value: string): void => { insertions.set(offset, (insertions.get(offset) ?? '') + value); };
			const visit = (node: ArkdownNode): void => {
				if (node.range.start >= draft.range.end || node.range.end <= draft.range.start || ['code_block', 'html_block', 'image', 'raw_html'].includes(node.kind)) return;
				if (node.children.length) { for (const child of node.children) visit(child); return; }
				if (!node.text) return;
				const start = node.kind === 'code' ? node.range.start : Math.max(node.range.start, draft.range.start);
				const end = node.kind === 'code' ? node.range.end : Math.min(node.range.end, draft.range.end);
				insert(start, `<span data-comment-id="${id}">`); insert(end, '</span>');
			};
			for (const node of this.cached!.nodes) visit(node);
			if (!insertions.size) throw new Error(localize({ bundle: 'ash.docs', key: 'commentSelectionUnsupported' }, 'Select document text outside a code block to add an anchored comment.'));
			for (const [offset, text] of insertions) edits.push({ range: { start: offset, end: offset }, text });
			const map = (offset: number, inclusive: boolean): number => offset + [...insertions].reduce((delta, [at, text]) => delta + (at < offset || inclusive && at === offset ? text.length : 0), 0);
			selection = { start: map(draft.range.start, true), end: map(draft.range.end, false) };
		}
		this.append(id, { op: 'create', message: this.message(body, authorId), ...(draft ? { quote: draft.quote.slice(0, 1000) } : {}) }, edits, selection);
		return id;
	}
	reply(threadId: string, body: string, authorId: string): void {
		if (this.thread(threadId).state === DocsCommentState.Resolved) throw new Error(localize({ bundle: 'ash.docs', key: 'commentReopenFirst' }, 'Reopen this thread before replying.'));
		this.append(threadId, { op: 'reply', message: this.message(body, authorId) });
	}
	editMessage(threadId: string, messageId: string, body: string): void {
		if (!this.thread(threadId).messages.some(message => message.id === messageId)) throw this.missing();
		this.append(threadId, { op: 'edit', messageId, body: body.trim(), editedAt: Date.now() });
	}
	setState(threadId: string, state: DocsCommentState): void { this.thread(threadId); this.append(threadId, { op: 'state', state }); }
	deleteMessage(threadId: string, messageId: string): void {
		const thread = this.thread(threadId);
		if (!thread.messages.some(message => message.id === messageId)) throw this.missing();
		if (thread.messages.length === 1) this.deleteThread(threadId);
		else this.append(threadId, { op: 'delete_message', messageId });
	}
	deleteThread(threadId: string): void {
		this.thread(threadId);
		const source = this.model.getValue(), edits: ArkdownEdit[] = [];
		const visit = (node: ArkdownNode): void => {
			if (node.kind === 'comment' && node.threadId === threadId) edits.push(
				{ range: { start: node.range.start, end: source.indexOf('>', node.range.start) + 1 }, text: '' },
				{ range: { start: source.lastIndexOf('</', node.range.end - 1), end: node.range.end }, text: '' });
			for (const child of node.children) visit(child);
		};
		for (const node of this.cached!.nodes) visit(node);
		this.append(threadId, { op: 'delete_thread' }, edits);
	}
	private message(body: string, authorId: string): DocsCommentMessage { return { id: generateUuid(), authorId, body: body.trim(), createdAt: Date.now() }; }
	private thread(id: string): DocsCommentThread {
		const thread = this.editable().threads.find(thread => thread.id === id);
		if (!thread) throw this.missing();
		return thread;
	}
	private editable(): DocsCommentSnapshot {
		if (!this.canEdit()) throw new Error(localize({ bundle: 'ash.docs', key: 'commentsReadonly' }, 'Comments are read-only in this document.'));
		const state = this.snapshot;
		if (state.invalid) throw new Error(localize({ bundle: 'ash.docs', key: 'commentsInvalid' }, 'Comment data could not be read. Use Markdown source to repair the ash-comments block.'));
		return state;
	}
	private missing(): Error { return new Error(localize({ bundle: 'ash.docs', key: 'commentMissing' }, 'This comment no longer exists.')); }
	private append(threadId: string, payload: DocsCommentEventPayload, edits: readonly ArkdownEdit[] = [], after?: ArkdownRange): void {
		const state = this.editable(), source = this.model.getValue(), before = this.getSelection();
		const clock = (this.cached!.events.at(-1)?.clock ?? 0) + 1;
		if (clock >= Number.MAX_SAFE_INTEGER) throw new Error(localize({ bundle: 'ash.docs', key: 'commentsLimit' }, 'Comment history has reached the document limit.'));
		const record = writeDocsCommentEvent({ ...payload, version: 1, id: generateUuid(), threadId, clock }).replace(/\n/gu, this.model.getEOL());
		if (this.cached!.events.length >= maxEvents || state.metadataRanges.reduce((size, range) => size + range.end - range.start, record.length) > DOCS_COMMENTS_MAX_SOURCE_LENGTH) throw new Error(localize({ bundle: 'ash.docs', key: 'commentsLimit' }, 'Comment history has reached the document limit.'));
		const insertions = new Map<number, string>(), replacements: ArkdownEdit[] = [];
		for (const edit of [...edits, { range: { start: source.length, end: source.length }, text: this.model.getEOL().repeat(2) + record }]) {
			if (edit.range.start === edit.range.end) insertions.set(edit.range.start, (insertions.get(edit.range.start) ?? '') + edit.text);
			else replacements.push(edit);
		}
		for (const [offset, text] of insertions) replacements.push({ range: { start: offset, end: offset }, text });
		const validated = this.runtime.validate(source, replacements);
		const map = (offset: number): number => {
			let delta = 0;
			for (const edit of validated) {
				if (edit.range.end < offset || edit.range.end === offset && edit.range.start !== edit.range.end) delta += edit.text.length - edit.range.end + edit.range.start;
				else if (edit.range.start < offset) return edit.range.start + delta;
			}
			return offset + delta;
		};
		const selection = after ?? { start: map(before.start), end: map(before.end) };
		this.model.pushStackElement();
		this.model.pushEditOperations([Selection.fromPositions(this.model.getPositionAt(before.start), this.model.getPositionAt(before.end))], validated.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })), () => [Selection.fromPositions(this.model.getPositionAt(selection.start), this.model.getPositionAt(selection.end))]);
		this.model.pushStackElement();
	}
}
