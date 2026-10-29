import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import './media/chatContextUsageDetails.css';
import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { getContextInputBudget, type ChatContextUsage } from '../../../../../services/chat/common/chatService.js';

/** Renders the context breakdown; the usage widget owns its floating presentation. */
export class ChatContextUsageDetails extends Disposable {
	readonly domNode: HTMLElement;
	private readonly body: HTMLElement;

	constructor(document: Document, onClose: () => void) {
		super();
		const root = h(document, 'div');
		this.domNode = root;
		root.className = 'ash-chat-context-details';
		root.id = createUuid();
		root.tabIndex = 0;
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'false');
		root.setAttribute('aria-label', localize('chat.input.contextUsage', 'Context usage'));
		const header = h(document, 'div');
		header.className = 'ash-chat-context-details-header';
		const title = h(document, 'h3');
		title.textContent = localize('chat.input.contextUsage', 'Context usage');
		const close = this._register(
			new Button(header, {
				...defaultButtonStyles,
				label: '',
				icon: Lxicon.close,
				iconOnly: true,
				size: 'small',
				ariaLabel: localize('chat.input.contextClose', 'Close context usage details'),
				onClick: onClose,
			}),
		);
		header.prepend(title);
		close.domNode.classList.add('ash-chat-context-details-close');
		this.body = h(document, 'div');
		root.append(header, this.body);
		this._register(toDisposable(() => root.remove()));
	}

	update(usage: ChatContextUsage): void {
		const body = this.body;
		const document = body.ownerDocument;
		const capacity = getContextInputBudget(usage);
		const categoryLabels = {
			systemPrompt: localize('chat.input.context.systemPrompt', 'System prompt'),
			systemTools: localize('chat.input.context.systemTools', 'Tools'),
			memoryFiles: localize('chat.input.context.memoryFiles', 'Memory files'),
			skills: localize('chat.input.context.skills', 'Skills'),
			conversation: localize('chat.input.context.conversation', 'Conversation'),
		};
		body.replaceChildren();
		const summary = h(document, 'p');
		summary.className = 'ash-chat-context-details-summary';
		summary.textContent =
			capacity !== undefined
				? localize(
						'chat.input.contextSummary',
						'Estimated input: {0} / {1} tokens · {2}%',
						usage.estimatedTokens.toLocaleString(),
						capacity.toLocaleString(),
						Math.round((usage.estimatedTokens / capacity) * 100),
					)
				: localize('chat.input.contextSummaryUnknown', '{0} tokens · Capacity unavailable', usage.estimatedTokens.toLocaleString());
		const bar = h(document, 'div');
		bar.className = 'ash-chat-context-details-bar';
		bar.setAttribute('aria-hidden', 'true');
		if (capacity !== undefined) {
			for (const { category, tokens } of usage.categories) {
				const segment = h(document, 'span');
				segment.className = 'ash-chat-context-category';
				segment.dataset.category = category;
				segment.style.width = `${Math.min(100, (tokens / capacity) * 100)}%`;
				bar.append(segment);
			}
		}
		const table = h(document, 'table');
		table.className = 'ash-chat-context-details-table';
		table.setAttribute('aria-label', localize('chat.input.contextBreakdown', 'Context breakdown'));
		const tableHead = table.createTHead().insertRow();
		const headings = [localize('chat.input.contextCategoryHeading', 'Category'), localize('chat.input.contextTokensHeading', 'Tokens')];
		if (capacity !== undefined) headings.push(localize('chat.input.contextShareHeading', 'Input budget share'));
		for (const label of headings) {
			const heading = h(document, 'th');
			heading.scope = 'col';
			heading.textContent = label;
			tableHead.append(heading);
		}
		const rows = table.createTBody();
		const appendRow = (label: string, tokens: number, category?: string): void => {
			const row = rows.insertRow();
			const heading = h(document, 'th');
			heading.scope = 'row';
			const marker = h(document, 'span');
			marker.className = 'ash-chat-context-category ash-chat-context-details-marker';
			marker.dataset.category = category ?? 'remaining';
			marker.setAttribute('aria-hidden', 'true');
			heading.append(marker, document.createTextNode(label));
			row.append(heading);
			row.insertCell().textContent = tokens.toLocaleString();
			if (capacity !== undefined) row.insertCell().textContent = `${((tokens / capacity) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
		};
		for (const { category, tokens } of usage.categories) appendRow(categoryLabels[category], tokens, category);
		if (capacity !== undefined) appendRow(localize('chat.input.contextRemaining', 'Remaining input budget'), Math.max(0, capacity - usage.estimatedTokens));
		const notes = h(document, 'div');
		notes.className = 'ash-chat-context-details-notes';
		const addNote = (text: string): void => {
			const note = h(document, 'p');
			note.textContent = text;
			notes.append(note);
		};
		if (usage.model) addNote(localize('chat.input.contextModel', 'Model: {0}/{1}', usage.model.provider, usage.model.model));
		if (usage.contextWindow !== undefined) addNote(localize('chat.input.contextCapacity', 'Model context capacity: {0} tokens', usage.contextWindow.toLocaleString()));
		if (usage.autoCompactAt !== undefined) addNote(localize('chat.input.contextCompaction', 'Automatic compaction at: {0} tokens', usage.autoCompactAt.toLocaleString()));
		if (usage.latestRequestTokens !== undefined) addNote(localize('chat.input.contextLatest', 'Latest request measurement: {0} tokens', usage.latestRequestTokens.toLocaleString()));
		addNote(localize('chat.input.contextDraft', 'The unsent draft is not included in this estimate.'));
		body.append(summary, bar, table, notes);
	}
}
