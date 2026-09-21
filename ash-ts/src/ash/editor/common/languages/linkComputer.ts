import { Range } from '../core/range.js';
import type { ILink } from '../languages.js';

export interface ILinkComputerTarget {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

const closingBrackets = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

/** Finds explicit HTTP(S) and file URLs without resolving or opening their targets. */
export function computeLinks(model: ILinkComputerTarget | null): ILink[] {
	const links: ILink[] = [];
	if (!model) {
		return links;
	}
	for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
		const line = model.getLineContent(lineNumber);
		for (const match of line.matchAll(/\b(?:https?|file):\/\/[^\s<>"'`\u0000-\u001f\u007f“”‘’《》【】|]+/giu)) {
			let url = match[0];
			const balance = new Map<string, number>([[')', 0], [']', 0], ['}', 0]]);
			for (const character of url) {
				const closing = closingBrackets.get(character);
				if (closing) {
					balance.set(closing, balance.get(closing)! + 1);
				} else if (balance.has(character)) {
					balance.set(character, balance.get(character)! - 1);
				}
			}
			while (url.length > 0) {
				const last = url.at(-1)!;
				if (/[.,;:!?*]/u.test(last)) {
					url = url.slice(0, -1);
				} else if ((balance.get(last) ?? 0) < 0) {
					balance.set(last, balance.get(last)! + 1);
					url = url.slice(0, -1);
				} else {
					break;
				}
			}
			if (!/^(?:https?|file):\/\/.+/iu.test(url)) {
				continue;
			}
			links.push({ range: new Range(lineNumber, match.index + 1, lineNumber, match.index + url.length + 1), url });
		}
	}
	return links;
}
