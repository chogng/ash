import { Tokenizer, type MarkedExtension, type Rules } from '../../../../../base/common/marked/marked.js';

const cjkLetter = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`;
const cjkTextEnd = String.raw`${cjkLetter}\p{Variation_Selector}?`;
const openingPunctuation = String.raw`[\p{Ps}\p{Pi}"']`;
const emphasisOpening = String.raw`\*+${openingPunctuation}`;
const emphasisClosing = String.raw`(?![*~])[\p{P}\p{S}]\*+${cjkLetter}`;
const afterCjkLetter = new RegExp(`${cjkTextEnd}$`, 'u');
const beforeQuotedEmphasis = new RegExp(`^${emphasisOpening}`, 'u');
const emphasisCandidate = new RegExp(String.raw`\*(?:${openingPunctuation}|${cjkLetter})`, 'u');
const cjkEmphasis = new RegExp(`${cjkTextEnd}${emphasisOpening}|${emphasisClosing}`, 'u');
const bareUrlBoundary = /[。．，、？！：；（）〖〗「」『』〈〉《》【】〔〕［］｛｝]/u;
const cjkEmphasisRules = new WeakMap<Rules['inline'], Rules['inline']>();

function getCjkEmphasisRules(inline: Rules['inline']): Rules['inline'] {
	let adapted = cjkEmphasisRules.get(inline);
	if (!adapted) {
		const rightDelimiter = inline.emStrongRDelimAst;
		// Extend Marked's first right-only alternative (punctuation, stars,
		// then whitespace or end). Its capture groups and priority stay intact.
		const source = rightDelimiter.source.replace(String.raw`(?=[\s]|$)`, () => String.raw`(?=[\s]|$|${cjkLetter})`);
		adapted = { ...inline, emStrongRDelimAst: new RegExp(source, rightDelimiter.flags) };
		cjkEmphasisRules.set(inline, adapted);
		cjkEmphasisRules.set(adapted, adapted);
	}
	return adapted;
}

const cjkMarkdown: MarkedExtension = {
	tokenizer: {
		emStrong(source, maskedSource, previous) {
			if (!source.startsWith('*')) return false;
			if (previous && beforeQuotedEmphasis.test(source)) {
				// Marked's previous character is one UTF-16 unit. Inspect the mask
				// to include supplementary characters and variation selectors.
				const offset = maskedSource.length - source.length;
				if (afterCjkLetter.test(maskedSource.slice(Math.max(0, offset - 4), offset))) {
					previous = ' ';
				}
			}
			const { rules } = this;
			const { inline } = rules;
			// Only the asterisk emphasis tokenizer uses the adapted rule. Code,
			// underscores and strikethrough keep the shared inline grammar.
			rules.inline = getCjkEmphasisRules(inline);
			try {
				return Tokenizer.prototype.emStrong.call(this, source, maskedSource, previous);
			} finally {
				rules.inline = inline;
			}
		},
		url(source) {
			const token = Tokenizer.prototype.url.call(this, source);
			const boundary = token?.raw.search(bareUrlBoundary) ?? -1;
			// Run the normal GFM backpedaling on the shortened candidate. The
			// lexer will consume the punctuation and any following text separately.
			return boundary < 0 ? token : Tokenizer.prototype.url.call(this, source.slice(0, boundary));
		},
	},
};

function hasCjkUrlBoundary(source: string): boolean {
	if (!bareUrlBoundary.test(source)) return false;
	for (const [candidate] of source.matchAll(/(?::\/\/|www\.)[^\s<]*/gu)) {
		if (bareUrlBoundary.test(candidate)) return true;
	}
	return false;
}

/** Rich extensions can introduce nested Markdown outside the outer source. */
export function getChatMarkdownExtensions(source: string, extensions?: readonly MarkedExtension[]): readonly MarkedExtension[] | undefined {
	if (extensions?.length || emphasisCandidate.test(source) && cjkEmphasis.test(source)
		|| (source.includes('://') || source.includes('www.')) && hasCjkUrlBoundary(source)) {
		return [cjkMarkdown, ...(extensions ?? [])];
	}
	return extensions;
}
