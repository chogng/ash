import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import type { AgentTraceEvent } from '../../common/chatDebugEvents.js';

export type ChatDebugEventKind = 'modelTurn' | 'toolCall' | 'subagentInvocation' | 'generic';

/** One editor-owned display filter. It never changes capture metrics or event identities. */
export class ChatDebugFilterState extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private parsed = parseFilter('');
	private readonly hiddenKinds = new Set<ChatDebugEventKind>();
	textFilter = '';
	errorsOnly = false;

	get error(): string | undefined {
		return typeof this.parsed === 'string' ? this.parsed : undefined;
	}
	get active(): boolean {
		return !!this.textFilter || this.errorsOnly || this.hiddenKinds.size > 0;
	}
	get hasTextTerms(): boolean {
		return typeof this.parsed !== 'string' && !!(this.parsed.include.length || this.parsed.exclude.length);
	}

	setTextFilter(value: string): void {
		if (value === this.textFilter) {
			return;
		}
		this.textFilter = value;
		this.parsed = parseFilter(value);
		this.changed.fire();
	}

	setErrorsOnly(value: boolean): void {
		if (value === this.errorsOnly) {
			return;
		}
		this.errorsOnly = value;
		this.changed.fire();
	}

	isKindVisible(kind: string): boolean {
		return !this.hiddenKinds.has(kind as ChatDebugEventKind);
	}

	setKindVisible(kind: ChatDebugEventKind, visible: boolean): void {
		if (visible === this.isKindVisible(kind)) {
			return;
		}
		if (visible) {
			this.hiddenKinds.delete(kind);
		} else {
			this.hiddenKinds.add(kind);
		}
		this.changed.fire();
	}

	reset(): void {
		this.textFilter = '';
		this.errorsOnly = false;
		this.hiddenKinds.clear();
		this.parsed = parseFilter('');
		this.changed.fire();
	}

	matches(record: AgentTraceEvent, turnId: string | undefined, failed: boolean, text: string): boolean {
		const parsed = this.parsed;
		if (typeof parsed === 'string' || (this.errorsOnly && !failed) || !this.isKindVisible(eventKind(record))) {
			return false;
		}
		if (parsed.threads.size && !parsed.threads.has(record.event.threadId)) {
			return false;
		}
		if (parsed.turns.size && (!turnId || !parsed.turns.has(turnId))) {
			return false;
		}
		if (record.recordedAt < parsed.after || record.recordedAt > parsed.before) {
			return false;
		}
		return (!parsed.include.length || parsed.include.some(term => text.includes(term))) && !parsed.exclude.some(term => text.includes(term));
	}
}

function eventKind(record: AgentTraceEvent): ChatDebugEventKind {
	const event = record.event;
	if (event.type.startsWith('model')) {
		return 'modelTurn';
	}
	if (event.type.startsWith('delegation') || event.type.startsWith('agentJoin') || event.type === 'threadCreated') {
		return 'subagentInvocation';
	}
	if (isRecord(event.item) && (event.item.type === 'toolCall' || event.item.type === 'toolResult')) {
		return 'toolCall';
	}
	return 'generic';
}

/** Date-only bounds use UTC day boundaries; timestamp bounds require an explicit zone.
 * Invalid bounds fail visibly instead of silently widening the search. Thread/Turn IDs
 * retain their case, while free-text inclusion/exclusion is case-insensitive. */
function parseFilter(query: string): { threads: Set<string>; turns: Set<string>; after: number; before: number; include: string[]; exclude: string[] } | string {
	const threads = new Set<string>();
	const turns = new Set<string>();
	let after = Number.NEGATIVE_INFINITY;
	let before = Number.POSITIVE_INFINITY;
	let invalid: string | undefined;
	const text = query.replace(/(^|[\s,])(thread|turn|after|before):([^\s,]*)/gi, (_match, separator: string, field: string, value: string) => {
		const key = field.toLowerCase();
		if (!value) {
			invalid = `${field}:`;
			return separator;
		}
		if (key === 'thread') {
			threads.add(value);
		} else if (key === 'turn') {
			turns.add(value);
		} else {
			const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
			const date = value.slice(0, 10);
			const day = Date.parse(`${date}T00:00:00Z`);
			const validDay = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === date;
			const validTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
			const timestamp = Date.parse(value);
			if (!validDay || (!dateOnly && !validTimestamp) || !Number.isFinite(timestamp)) {
				invalid = `${field}:${value}`;
			} else if (key === 'after') {
				after = Math.max(after, timestamp);
			} else {
				before = Math.min(before, timestamp + (dateOnly ? 86_400_000 - 1 : 0));
			}
		}
		return separator;
	});
	if (invalid !== undefined || after > before) {
		return localize('agentTrace.invalidFilter', 'Invalid trace filter: {0}. Use Thread/Turn IDs or ISO dates; timestamps need a time zone, and after must not exceed before.', invalid ?? query);
	}
	const terms = text
		.split(',')
		.map(term => term.trim().toLowerCase())
		.filter(Boolean);
	return {
		threads,
		turns,
		after,
		before,
		include: terms.filter(term => !term.startsWith('!')),
		exclude: terms.filter(term => term.startsWith('!') && term.length > 1).map(term => term.slice(1)),
	};
}
