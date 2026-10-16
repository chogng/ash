import type { MarkedExtension } from '../../../../base/common/marked/marked.js';
import { htmlAttributeEncodeValue } from '../../../../base/common/strings.js';

const katexContainerClassName = 'ash-katex-container';
export const katexContainerLatexAttributeName = 'data-latex';

interface MathContent { readonly raw: string; readonly text: string; readonly displayMode: boolean; }

/** Reads delimiters without consuming incomplete formulas or treating currency/jQuery as math. */
function readMath(source: string, previous = ''): MathContent | undefined {
	const opening = source.startsWith('\\(') ? '\\(' : source.startsWith('\\[') ? '\\[' : source.startsWith('$$') ? '$$' : source.startsWith('$') ? '$' : undefined;
	if (!opening || (opening.startsWith('$') && /[\p{L}\p{N}]/u.test(previous.slice(-1)))) { return undefined; }
	if (opening === '$' && /[\s.(]/u.test(source[1] ?? '')) { return undefined; }
	const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
	for (let index = opening.length; index < Math.min(source.length, 20_000); index++) {
		if (source.startsWith(closing, index)) {
			if (opening.startsWith('$') && /[\p{L}\p{N}]/u.test(source[index + closing.length] ?? '')) { return undefined; }
			const text = source.slice(opening.length, index).trim();
			if (!text || opening === '$' && text.includes('\n')) { return undefined; }
			return { raw: source.slice(0, index + closing.length), text, displayMode: opening === '$$' || opening === '\\[' };
		}
		if (source[index] === '\\') { index++; }
	}
	return undefined;
}

export namespace MarkedKatexExtension {
	// Only the string-rendering contract crosses into common; KaTeX's DOM
	// entrypoints and their HTMLElement types belong to the browser host.
	export interface MarkedKatexOptions {
		readonly displayMode?: boolean;
		readonly throwOnError?: boolean;
		readonly trust?: boolean;
		readonly maxExpand?: number;
		readonly maxSize?: number;
		readonly macros?: Record<string, string>;
	}


	export function extension(katex: { renderToString(text: string, options: MarkedKatexOptions): string; }, options: MarkedKatexOptions = {}): MarkedExtension {
		return {
			extensions: (['block', 'inline'] as const).map(level => ({
				name: `ashMath${level}`, level,
				start(source) {
					for (let index = 0; index < source.length; index++) {
						if (level === 'block' && source[index - 1] !== '\n') { continue; }
						if (source[index] === '\\' && !['(', '['].includes(source[index + 1])) { index++; continue; }
						if (readMath(source.slice(index), source.slice(Math.max(0, index - 1), index))) { return index; }
					}
					return -1;
				},
				tokenizer(source, tokens) {
					const previous = tokens.at(-1);
					const math = readMath(source, previous?.type === 'text' ? previous.raw : '');
					if (!math || level === 'block' && !math.displayMode) { return undefined; }
					return { type: `ashMath${level}`, ...math };
				},
				renderer(token) {
					try {
						const body = katex.renderToString(token.text as string, { ...options, displayMode: token.displayMode as boolean, throwOnError: true, trust: false, maxExpand: 1000, maxSize: 50 });
						return `<span class="${katexContainerClassName}" ${katexContainerLatexAttributeName}="${htmlAttributeEncodeValue(token.text as string)}">${body}</span>`;
					} catch {
						// Invalid or unsupported LaTeX remains readable, including its delimiters.
						return htmlAttributeEncodeValue(token.raw);
					}
				},
			})),
		};
	}
}
