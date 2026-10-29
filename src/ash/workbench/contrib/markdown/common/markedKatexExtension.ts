import type { MarkedExtension } from '../../../../base/common/marked/marked.js';
import { htmlAttributeEncodeValue } from '../../../../base/common/strings.js';

const wordCharacter = /[\p{Alphabetic}\p{N}]/u;

const katexContainerClassName = 'ash-katex-container';
export const katexContainerLatexAttributeName = 'data-latex';

interface MathContent {
	readonly raw: string;
	readonly text: string;
	readonly displayMode: boolean;
}

/** Reads delimiters without consuming incomplete formulas or treating currency/jQuery as math. */
function readMath(source: string, previous = ''): MathContent | undefined {
	const opening = source.startsWith('\\(') ? '\\(' : source.startsWith('\\[') ? '\\[' : source.startsWith('$$') ? '$$' : source.startsWith('$') ? '$' : undefined;
	if (!opening) {
		return undefined;
	}
	// Read complete code points before testing boundaries, including astral letters.
	const tail = previous.slice(-2);
	const before = (tail.codePointAt(0) ?? 0) > 0xffff ? tail : tail.slice(-1);
	if (opening.startsWith('$') && wordCharacter.test(before)) {
		return undefined;
	}
	if (opening === '$' && /[\s.(]/u.test(source[1] ?? '')) {
		return undefined;
	}
	const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
	// Search closing delimiters natively instead of visiting every character for
	// each incomplete candidate. An odd preceding backslash count escapes the
	// delimiter; advance one character so overlapping dollar pairs remain eligible.
	const boundedSource = source.slice(0, 20_001);
	for (let cursor = opening.length; cursor < 20_000;) {
		const index = boundedSource.indexOf(closing, cursor);
		if (index < 0 || index >= 20_000) {
			return undefined;
		}
		let escaped = 0;
		for (let before = index - 1; before >= opening.length && source[before] === '\\'; before--) {
			escaped++;
		}
		if (escaped % 2 === 0) {
			const after = source.codePointAt(index + closing.length);
			if (opening.startsWith('$') && after !== undefined && wordCharacter.test(String.fromCodePoint(after))) {
				return undefined;
			}
			const text = source.slice(opening.length, index).trim();
			if (!text || (opening === '$' && (/[\r\n]/u.test(text) || /\s/u.test(source[index - 1])))) {
				return undefined;
			}
			return {
				raw: source.slice(0, index + closing.length),
				text,
				displayMode: opening === '$$' || opening === '\\[',
			};
		}
		cursor = index + 1;
	}
	return undefined;
}

/** Only complete CommonMark math fences become formulas during streaming. */
function readMathFence(source: string): MathContent | undefined {
	const opening = /^ {0,3}(`{3,}|~{3,})[^\S\r\n]*math(?:[^\S\r\n]+[^\r\n]*)?\r?\n/u.exec(source);
	if (!opening || (opening[1][0] === '`' && opening[0].slice(opening[1].length + source.indexOf(opening[1])).includes('`'))) {
		return undefined;
	}
	let start = opening[0].length;
	while (start < source.length) {
		const newline = source.indexOf('\n', start);
		const end = newline < 0 ? source.length : newline + 1;
		const line = source.slice(start, end);
		const closing = /^ {0,3}(`+|~+)[^\S\r\n]*(?:\r?\n)?$/u.exec(line);
		if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length) {
			return {
				raw: source.slice(0, end),
				text: source.slice(opening[0].length, start).trim(),
				displayMode: true,
			};
		}
		start = end;
	}
	return undefined;
}

export namespace MarkedKatexExtension {
	/** Tokenization stays in the host; the optional math extension owns formula rendering. */
	export function extension(): MarkedExtension {
		return {
			extensions: (['block', 'inline'] as const).map(level => ({
				name: `ashMath${level}`,
				level,
				start(source) {
					// Marked asks for the next extension before each ordinary inline token.
					// Scan plain prose natively; slicing and checking every character here
					// repeatedly walks the remaining paragraph as links/emphasis are consumed.
					const candidates = /[$\\]/gu;
					let candidate: RegExpExecArray | null;
					while ((candidate = candidates.exec(source))) {
						const index = candidate.index;
						if (level === 'block' && source[index - 1] !== '\n') {
							continue;
						}
						// An ordinary escape consumes its next character, including a dollar
						// or another backslash that would otherwise look like a delimiter.
						if (source[index] === '\\' && !['(', '['].includes(source[index + 1])) {
							candidates.lastIndex++;
							continue;
						}
						if (readMath(source.slice(index), source.slice(Math.max(0, index - 2), index))) {
							return index;
						}
					}
					return -1;
				},
				tokenizer(source, tokens) {
					if (level === 'block') {
						const fence = readMathFence(source);
						if (fence) {
							return { type: 'ashMathblock', ...fence };
						}
					}
					const previous = tokens.at(-1);
					const math = readMath(source, previous?.type === 'text' ? previous.raw : '');
					if (!math || (level === 'block' && !math.displayMode)) {
						return undefined;
					}
					return { type: `ashMath${level}`, ...math };
				},
				renderer(token) {
					const display = token.displayMode ? 'block' : 'inline';
					return `<span class="${katexContainerClassName} ash-markdown-math" ${katexContainerLatexAttributeName}="${htmlAttributeEncodeValue(token.text as string)}" data-math-display="${display}">${htmlAttributeEncodeValue(token.raw)}</span>`;
				},
			})),
		};
	}
}
