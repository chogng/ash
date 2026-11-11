import { Marked, type Tokens } from '../../../../../base/common/marked/marked.js';
import type { ThreadItem, Turn } from '../../../../../platform/agentHost/common/agent.js';

const followupAnchor = '#ash-followup';
const lexer = new Marked();

/** A final Markdown list also remains readable in clients without a suggestion picker. */
export function parseChatFollowupFooter(source: string): { readonly text: string; readonly prompts: readonly string[]; } | undefined {
	if (!source.includes(followupAnchor)) return undefined;
	const markdown = source.replace(/\r\n?/gu, '\n').trimEnd();
	const footer = lexer.lexer(markdown).at(-1) as Tokens.List | undefined;
	if (footer?.type !== 'list' || footer.ordered || footer.items.length > 3 || !markdown.endsWith(footer.raw)) return undefined;
	const text = markdown.slice(0, -footer.raw.length).trimEnd();
	if (!text) return undefined;

	const prompts = new Set<string>();
	for (const item of footer.items) {
		const paragraph = item.tokens[0] as Tokens.Text | undefined;
		const link = paragraph?.tokens?.[0] as Tokens.Link | undefined;
		if (item.task || item.tokens.length !== 1 || paragraph?.tokens?.length !== 1 || link?.type !== 'link'
			|| link.href !== followupAnchor || link.title || !link.tokens.every(token => token.type === 'text')) return undefined;
		const prompt = link.text.trim();
		if (!prompt || prompt.length > 180 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(prompt)) return undefined;
		prompts.add(prompt);
	}
	return { text, prompts: [...prompts] };
}

export function chatResponseFollowups(turn: Turn | undefined): { readonly responseId: string; readonly prompts: readonly string[]; } | undefined {
	if (turn?.status !== 'completed' || turn.kind && turn.kind !== 'coding') return undefined;
	const reply = lastChatAgentReply(turn);
	if (!reply) return undefined;
	const footer = parseChatFollowupFooter(reply.text);
	return footer && { responseId: reply.itemId, prompts: footer.prompts };
}

export function lastChatAgentReply(turn: Turn): Extract<ThreadItem, { type: 'agentMessage'; }> | undefined {
	for (let index = turn.items.length - 1; index >= 0; index--) {
		const item = turn.items[index];
		if (item.type === 'agentMessage') return item;
	}
	return undefined;
}
