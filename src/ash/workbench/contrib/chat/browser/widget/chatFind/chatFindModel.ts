import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import type { ChatMarkdownRichContent } from '../../../common/model/chatMarkdownRichContent.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { getChatFindTextParts, type IChatFindTextPart } from './chatFindContent.js';

export const MAX_FIND_MATCHES = 9999;

export interface IChatFindOptions {
	readonly isRegex: boolean;
	readonly matchCase: boolean;
	readonly wholeWord: boolean;
}

export interface IChatFindMatch {
	readonly itemId: string;
	readonly partIndex: number;
	readonly codeBlockIndex?: number;
	readonly occurrenceIndex: number;
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/** Owns one presentation's query and derived matches; messages remain owned by the conversation model. */
export class ChatFindModel extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly parts = new Map<string, {
		readonly text: string;
		readonly type: IChatListItem['type'];
		readonly richContent: ChatMarkdownRichContent | undefined;
		readonly parts: readonly IChatFindTextPart[];
	}>();
	private search = '';
	private settings: IChatFindOptions = { isRegex: false, matchCase: false, wholeWord: false };
	private pattern: RegExp | undefined;
	private invalid = false;
	private results: readonly IChatFindMatch[] = [];
	private index = -1;
	private truncated = false;
	private suspendedMatch: Pick<IChatFindMatch, 'itemId' | 'partIndex' | 'start' | 'end'> | undefined;

	constructor(
		private readonly getItems: () => readonly IChatListItem[],
		private readonly getViewportAnchorItemId: () => string | undefined = () => undefined,
	) {
		super();
	}

	public get query(): string { return this.search; }
	public get options(): IChatFindOptions { return this.settings; }
	public get isInvalidRegex(): boolean { return this.invalid; }
	public get matches(): readonly IChatFindMatch[] { return this.results; }
	public get activeIndex(): number { return this.index; }
	public get activeMatch(): IChatFindMatch | undefined { return this.results[this.index]; }
	public get isTruncated(): boolean { return this.truncated; }
	/** Consumers receive an independent cursor for DOM and editor matching. */
	public get regex(): RegExp | undefined { return this.pattern && new RegExp(this.pattern.source, this.pattern.flags); }

	public setQuery(query: string, options: IChatFindOptions): void {
		if (query === this.search && options.isRegex === this.settings.isRegex && options.matchCase === this.settings.matchCase && options.wholeWord === this.settings.wholeWord) {
			return;
		}
		this.search = query;
		this.settings = { ...options };
		this.invalid = false;
		this.pattern = undefined;
		this.index = -1;
		this.results = [];
		this.suspendedMatch = undefined;
		if (query) {
			let source = options.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			try {
				// Validate the expression itself before wrapping it in word boundaries.
				// Otherwise an unmatched character class can consume the wrapper.
				if (options.isRegex) { new RegExp(source, 'u'); }
				if (options.wholeWord) {
					source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
				}
				this.pattern = new RegExp(source, options.matchCase ? 'gu' : 'giu');
			} catch {
				this.invalid = true;
			}
		}
		this.recompute();
	}

	public recompute(): void {
		if (this.isDisposed) { return; }
		const active = this.activeMatch ?? this.suspendedMatch;
		this.suspendedMatch = undefined;
		const matches: IChatFindMatch[] = [];
		const live = new Set<string>();
		this.truncated = false;
		if (this.pattern) {
			outer: for (const item of this.getItems()) {
				live.add(item.id);
				// Markdown markers can stay the same when their referenced rich content changes.
				const richContent = item.type === 'agentMessage' ? item.markdown?.richContent : undefined;
				let cached = this.parts.get(item.id);
				if (!cached || cached.text !== item.text || cached.type !== item.type || cached.richContent !== richContent) {
					cached = { text: item.text, type: item.type, richContent, parts: getChatFindTextParts(item) };
					this.parts.set(item.id, cached);
				}
				for (const [partIndex, part] of cached.parts.entries()) {
					this.pattern.lastIndex = 0;
					let occurrenceIndex = 0;
					let match: RegExpExecArray | null;
					while ((match = this.pattern.exec(part.text))) {
						if (!match[0].length) {
							this.pattern.lastIndex += (part.text.codePointAt(this.pattern.lastIndex) ?? 0) > 0xffff ? 2 : 1;
							continue;
						}
						if (matches.length === MAX_FIND_MATCHES) {
							this.truncated = true;
							break outer;
						}
						matches.push({ itemId: item.id, partIndex, codeBlockIndex: part.codeBlockIndex, occurrenceIndex: occurrenceIndex++, start: match.index, end: match.index + match[0].length, text: match[0] });
					}
				}
			}
		}
		for (const id of this.parts.keys()) {
			if (!live.has(id)) { this.parts.delete(id); }
		}
		this.results = matches;
		this.index = active ? matches.findIndex(match => match.itemId === active.itemId && match.partIndex === active.partIndex && match.start === active.start && match.end === active.end) : -1;
		if (this.index < 0 && matches.length) {
			const anchor = this.getViewportAnchorItemId();
			this.index = Math.max(0, matches.findIndex(match => match.itemId === anchor));
		}
		this.changed.fire();
	}

	public next(): IChatFindMatch | undefined {
		if (this.results.length) { this.index = (this.index + 1) % this.results.length; }
		this.changed.fire();
		return this.activeMatch;
	}

	public previous(): IChatFindMatch | undefined {
		if (this.results.length) { this.index = (this.index + this.results.length - 1) % this.results.length; }
		this.changed.fire();
		return this.activeMatch;
	}

	/** Drops derived transcript data while retaining the query and position for reopening. */
	public suspend(): void {
		if (this.activeMatch) {
			const { itemId, partIndex, start, end } = this.activeMatch;
			this.suspendedMatch = { itemId, partIndex, start, end };
		}
		this.results = [];
		this.parts.clear();
		this.index = -1;
		this.truncated = false;
		this.changed.fire();
	}
}
