import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	getContextInputBudget, IChatService,
	type ChatContextUsage, type ModelUsageSummary, type ModelUsageTotal,
} from '../../../services/chat/common/chatService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import { IChatWidgetService } from './chat.js';

/** Read-only presentation snapshots; Chat remains the owner of context and recorded usage. */
export class ChatUsageSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'chat-usage';
	readonly itemId = 'chat.usage';
	readonly groupId = null;
	get title(): string { return localize('chat.usage.title', 'Usage'); }
	get description(): string { return localize('chat.usage.description', 'Inspect the current chat’s context estimate and accumulated token usage.'); }
	get keywords(): readonly string[] { return ['context', 'tokens', 'usage', 'budget', localize('chat.usage.title', 'Usage')]; }
	get help(): string {
		return localize('chat.usage.help', 'Usage settings show the current chat’s estimated context, category breakdown, model limits, and accumulated token usage. Context percentages use the automatic compaction input budget. Accumulated usage counts model invocations across the chat and is separate from the current context estimate. Cached and reasoning tokens are details of the reported input and output, not additional totals. Unreported measurements are shown as unavailable; incomplete totals are marked as at least. The unsent draft is excluded. Activate Refresh to read the latest measurements. Use Tab to reach Refresh. Close Settings to return to your chat.');
	}
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly refreshSoon = this._register(new RunOnceScheduler(() => { void this.load(); }, 100));
	private visible = false;
	private generation = 0;
	private target: { readonly sessionId: string; readonly threadId: string; } | undefined;
	private snapshot: { readonly context: ChatContextUsage; readonly usage: ModelUsageSummary; readonly title: string; } | undefined;
	private message = '';

	constructor(
		@IChatService private readonly chat: IChatService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
	) {
		super();
		this._register(widgets.onDidChangeWidgets(() => {
			if (this.visible) { void this.load(); }
		}));
		this._register(chat.onDidBecomeReady(() => {
			if (this.visible) { void this.load(); }
		}));
		this._register(chat.onDidUpdateThread(event => {
			if (this.visible && event.sessionId === this.target?.sessionId && event.threadId === this.target.threadId && event.update.type === 'committed') {
				this.refreshSoon.schedule();
			}
		}));
	}

	get fields(): readonly SettingsSectionField[] {
		const snapshot = this.snapshot;
		const context = snapshot?.context;
		const budget = context && getContextInputBudget(context);
		const unavailable = localize('chat.usage.unavailable', 'Unavailable');
		const count = (value: number | undefined): string => value === undefined ? unavailable : value.toLocaleString();
		const tokenCount = (value: number | undefined): string => value === undefined ? unavailable : localize('chat.usage.tokens', '{0} tokens', value.toLocaleString());
		const status = (id: string, text: string): SettingsSectionField => ({ id, kind: 'status', text });
		const categories: readonly [ChatContextUsage['categories'][number]['category'], string][] = [
			['systemPrompt', localize('chat.input.context.systemPrompt', 'System prompt')],
			['systemTools', localize('chat.input.context.systemTools', 'Tools')],
			['memoryFiles', localize('chat.input.context.memoryFiles', 'Memory files')],
			['skills', localize('chat.input.context.skills', 'Skills')],
			['conversation', localize('chat.input.context.conversation', 'Conversation')],
		];
		const usage = snapshot?.usage;
		return [
			status('state', this.message),
			status('chat', snapshot ? localize('chat.usage.chat', 'Chat: {0}', snapshot.title) : ''),
			status('context', context ? localize('chat.usage.context', 'Estimated context: {0} tokens', count(context.estimatedTokens)) : ''),
			status('budget', context && budget !== undefined
				? localize('chat.usage.budget', 'Input budget: {0} tokens · {1}% used', count(budget), Math.round(context.estimatedTokens / budget * 100)) : ''),
			...categories.map(([category, label]) => {
				if (!context) { return status(category, ''); }
				const tokens = context.categories.find(entry => entry.category === category)?.tokens;
				if (tokens !== undefined && budget !== undefined) {
					const share = (tokens / budget * 100).toLocaleString(undefined, { maximumFractionDigits: 1 });
					return status(category, localize('chat.usage.categoryShare', '{0}: {1} tokens · {2}%', label, count(tokens), share));
				}
				return status(category, localize('chat.usage.category', '{0}: {1}', label, tokenCount(tokens)));
			}),
			status('remaining', context && budget !== undefined ? localize('chat.usage.remaining', 'Remaining input budget: {0} tokens', count(Math.max(0, budget - context.estimatedTokens))) : ''),
			status('model', context?.model ? localize('chat.input.contextModel', 'Model: {0}/{1}', context.model.provider, context.model.model) : ''),
			status('capacity', context ? localize('chat.usage.capacity', 'Model context capacity: {0}', tokenCount(context.contextWindow)) : ''),
			status('compaction', context ? localize('chat.usage.compaction', 'Automatic compaction at: {0}', tokenCount(context.autoCompactAt)) : ''),
			status('latest', context ? localize('chat.usage.latest', 'Latest request measurement: {0}', tokenCount(context.latestRequestTokens)) : ''),
			status('draft', context ? localize('chat.input.contextDraft', 'The unsent draft is not included in this estimate.') : ''),
			status('accumulated', usage ? localize('chat.usage.accumulated', 'Accumulated chat usage · {0} model invocations', count(usage.modelInvocations)) : ''),
			status('input', usage ? localize('chat.usage.input', 'Input tokens: {0}', this.total(usage.inputTokens)) : ''),
			status('output', usage ? localize('chat.usage.output', 'Output tokens: {0}', this.total(usage.outputTokens)) : ''),
			status('cached', usage ? localize('chat.usage.cached', 'Cached input tokens: {0}', this.total(usage.cachedInputTokens)) : ''),
			status('cacheWrite', usage ? localize('chat.usage.cacheWrite', 'Cache write input tokens: {0}', this.total(usage.cacheWriteInputTokens)) : ''),
			status('reasoning', usage ? localize('chat.usage.reasoning', 'Reasoning tokens: {0}', this.total(usage.reasoningTokens)) : ''),
			{ id: 'refresh', kind: 'action', label: localize('chat.usage.refresh', 'Refresh'), enabled: this.visible && this.target !== undefined, run: () => this.load() },
		];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible) { void this.load(); }
		else {
			this.generation++;
			this.refreshSoon.cancel();
		}
	}

	private total(value: ModelUsageTotal): string {
		if (value.complete) { return value.reported.toLocaleString(); }
		return value.reported > 0
			? localize('chat.usage.atLeast', 'At least {0}', value.reported.toLocaleString())
			: localize('chat.usage.unavailable', 'Unavailable');
	}

	private async load(): Promise<void> {
		if (!this.visible || this.isDisposed) { return; }
		this.refreshSoon.cancel();
		const generation = ++this.generation;
		const widget = this.widgets.lastFocusedWidget ?? this.widgets.getAllWidgets().find(widget => widget.visible && widget.sessionId && widget.threadId);
		const sessionId = widget?.sessionId;
		const threadId = widget?.threadId;
		if (sessionId !== this.target?.sessionId || threadId !== this.target?.threadId) { this.snapshot = undefined; }
		this.target = sessionId && threadId ? { sessionId, threadId } : undefined;
		if (!this.target) {
			this.snapshot = undefined;
			this.message = localize('chat.usage.noChat', 'Open a chat to inspect its usage.');
			this.changed.fire();
			return;
		}
		this.message = this.snapshot ? '' : localize('chat.usage.loading', 'Loading usage…');
		const target = this.target;
		this.changed.fire();
		if (!this.visible || this.isDisposed || generation !== this.generation) { return; }
		try {
			const [context, { thread }] = await Promise.all([
				this.chat.readContextUsage(target.sessionId, target.threadId),
				// Thread-level totals do not require loading its complete conversation history.
				this.chat.readThread(target.sessionId, target.threadId, { type: 'latest', turnLimit: 1 }),
			]);
			if (!this.visible || this.isDisposed || generation !== this.generation) { return; }
			this.snapshot = { context, usage: thread.usage, title: thread.title || thread.threadId };
			this.message = '';
		} catch (error) {
			if (!this.visible || this.isDisposed || generation !== this.generation) { return; }
			this.message = localize('chat.usage.loadFailed', 'Could not load usage: {0}', String(error));
		}
		this.changed.fire();
	}
}
