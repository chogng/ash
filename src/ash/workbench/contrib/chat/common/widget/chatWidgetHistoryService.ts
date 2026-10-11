import { TaskQueue } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IMessageHistoryService, type MessageHistoryEntry, type MessageHistoryKind, type MessageHistoryPage } from '../../../../../platform/messageHistory/common/messageHistory.js';

export type ChatHistoryNavigationResult<TDraft> = { readonly kind: 'history'; readonly entry: MessageHistoryEntry; } | { readonly kind: 'draft'; readonly draft: TDraft; };

type Navigation<TDraft> = { readonly draft: TDraft; readonly entries: MessageHistoryEntry[]; index: number; before: string | undefined; loaded: boolean; };

/** Owns one composer's temporary navigation, while the backend remains the only input store. */
export class ChatHistoryNavigator<TDraft> extends Disposable {
	private readonly operations = new TaskQueue();
	private navigation: Navigation<TDraft> | undefined;
	private generation = 0;

	constructor(@IMessageHistoryService private readonly history: IMessageHistoryService | undefined) {
		super();
		this._register(toDisposable(() => { this.reset(); this.operations.clearPending(); }));
	}

	get available(): boolean { return this.history !== undefined; }
	get active(): boolean { return this.navigation !== undefined; }

	invalidatePending(): void { this.generation++; }

	reset(): void {
		this.generation++;
		this.navigation = undefined;
	}

	restore(): TDraft | undefined {
		const draft = this.navigation?.draft;
		this.reset();
		return draft;
	}

	async record(text: string, kind: MessageHistoryKind): Promise<void> {
		this.reset();
		if (text.trim()) await this.history?.append({ text, kind });
	}

	previous(draft: TDraft): Promise<ChatHistoryNavigationResult<TDraft> | undefined> {
		if (!this.history) return Promise.resolve(undefined);
		const generation = this.generation;
		return this.operations.scheduleSkipIfCleared(async () => {
			if (this.isDisposed || generation !== this.generation) return undefined;
			const navigation = this.navigation ??= { draft, entries: [], index: -1, before: undefined, loaded: false };
			if (navigation.index + 1 >= navigation.entries.length && (!navigation.loaded || navigation.before !== undefined)) {
				const page = await this.history!.read({ before: navigation.before, text: '', limit: 40 });
				if (this.isDisposed || generation !== this.generation || this.navigation !== navigation) return undefined;
				navigation.entries.push(...page.entries);
				navigation.before = page.nextBefore;
				navigation.loaded = true;
			}
			if (navigation.index + 1 >= navigation.entries.length) return undefined;
			return { kind: 'history', entry: navigation.entries[++navigation.index]! };
		});
	}

	next(): Promise<ChatHistoryNavigationResult<TDraft> | undefined> {
		const generation = this.generation;
		return this.operations.scheduleSkipIfCleared(() => {
			if (this.isDisposed || generation !== this.generation || !this.navigation) return undefined;
			if (this.navigation.index <= 0) return { kind: 'draft', draft: this.restore()! };
			return { kind: 'history', entry: this.navigation.entries[--this.navigation.index]! };
		});
	}

	select(entry: MessageHistoryEntry, draft: TDraft): void {
		const original = this.navigation?.draft ?? draft;
		this.reset();
		this.navigation = { draft: original, entries: [entry], index: 0, before: entry.id, loaded: true };
	}

	search(text: string, before?: string): Promise<MessageHistoryPage> {
		return this.history?.read({ text, before, limit: 40 }) ?? Promise.resolve({ entries: [] });
	}
}
