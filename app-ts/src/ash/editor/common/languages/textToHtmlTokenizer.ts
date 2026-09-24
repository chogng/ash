import type { IViewLineTokens } from '../tokens/lineTokens.js';

/** Serializes one selected line fragment; regular whitespace preserves source tabs. */
export function tokenizeLineToHTML(text: string, viewLineTokens: IViewLineTokens, colorMap: string[], startOffset: number, endOffset: number, tabSize: number, useNbsp: boolean): string {
	const fragments: string[] = [];
	let column = 0;
	if (useNbsp) {
		for (let offset = 0; offset < startOffset; offset++) {
			column += text[offset] === '\t' ? tabSize - column % tabSize : 1;
		}
	}
	for (let token = viewLineTokens.findTokenIndexAtOffset(startOffset); token < viewLineTokens.getCount(); token++) {
		const start = Math.max(startOffset, token === 0 ? 0 : viewLineTokens.getEndOffset(token - 1));
		const end = Math.min(endOffset, viewLineTokens.getEndOffset(token));
		if (start >= endOffset) {
			break;
		}
		let content = text.slice(start, end);
		if (useNbsp) {
			content = content.replace(/[\s\S]/g, character => {
				const width = character === '\t' ? tabSize - column % tabSize : 1;
				column += width;
				return character === '\t' || character === ' ' ? '\u00a0'.repeat(width) : character;
			});
		}
		const style = viewLineTokens.getInlineStyle(token, colorMap);
		const escaped = escapeHtml(content);
		fragments.push(style ? `<span style="${escapeHtml(style)}">${escaped}</span>` : escaped);
	}
	return fragments.join('');
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
