import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { Marked, type Token, type Tokens } from '../../../../../../base/common/marked/marked.js';
import type { IChatListItem } from '../chatListItems.js';

export interface IChatFindTextPart {
	readonly text: string;
	readonly codeBlockIndex?: number;
}

/** Derives searchable text from message content, excluding tool evidence and Markdown destinations. */
export function getChatFindTextParts(item: IChatListItem): readonly IChatFindTextPart[] {
	if (item.type === 'userMessage' || item.type === 'voiceTranscript') {
		return [{ text: item.text }];
	}
	if (item.type !== 'agentMessage') {
		return [];
	}
	const parts: IChatFindTextPart[] = [];
	let codeBlockIndex = 0;
	const visit = (tokens: readonly Token[]): void => {
		for (const token of tokens) {
			if (token.type === 'code') {
				parts.push({ text: (token as Tokens.Code).text, codeBlockIndex: codeBlockIndex++ });
			} else if (token.type === 'blockquote') {
				visit((token as Tokens.Blockquote).tokens);
			} else if (token.type === 'list') {
				for (const item of (token as Tokens.List).items) {
					visit(item.tokens);
				}
			} else if (token.type === 'table') {
				const table = token as Tokens.Table;
				for (const row of [table.header, ...table.rows]) {
					for (const cell of row) {
						parts.push({ text: renderAsPlaintext(cell.text) });
					}
				}
			} else if (token.type !== 'space' && token.type !== 'hr' && token.type !== 'def') {
				const text = renderAsPlaintext(token.raw);
				if (text) {
					parts.push({ text });
				}
			}
		}
	};
	visit(new Marked().lexer(item.text, { gfm: true }));
	return parts;
}
