import { MetadataConsts, StandardTokenType } from '../../encodedTokenAttributes.js';
import { type ILanguageConfigurationService } from '../../languages/languageConfigurationRegistry.js';
import { type OpeningBracketKind } from '../../languages/supports/languageBracketsConfiguration.js';
import { createBracketOrRegExp } from '../../languages/supports/richEditBrackets.js';
import { type IViewLineTokens } from '../../tokens/lineTokens.js';

/** Repairs bracket pairs in proposed text, respecting lexical and embedded-language boundaries. */
export function fixBracketsInLine(tokens: IViewLineTokens, languageConfigurationService: ILanguageConfigurationService): string {
	const text = tokens.getLineContent();
	const stack: OpeningBracketKind[] = [];
	const parts: string[] = [];
	let copied = 0;
	for (let index = 0; index < tokens.getCount();) {
		const start = index === 0 ? 0 : tokens.getEndOffset(index - 1);
		const languageId = tokens.getLanguageId(index);
		if (!includesBrackets(tokens, index)) { index++; continue; }
		let end = tokens.getEndOffset(index++);
		while (index < tokens.getCount() && tokens.getLanguageId(index) === languageId && includesBrackets(tokens, index)) {
			end = tokens.getEndOffset(index++);
		}
		const brackets = languageConfigurationService.getLanguageConfiguration(languageId).bracketsNew;
		if (brackets.openingBrackets.length === 0) continue;
		const texts = [...brackets.openingBrackets, ...brackets.closingBrackets].map(bracket => bracket.bracketText);
		const expression = createBracketOrRegExp(texts.sort((left, right) => right.length - left.length), { global: true, matchCase: true });
		for (const match of text.slice(start, end).matchAll(expression)) {
			const bracket = brackets.getBracketInfo(match[0]);
			if (!bracket) continue;
			if (bracket.isOpeningBracket) {
				stack.push(bracket);
				continue;
			}
			const offset = start + match.index;
			parts.push(text.slice(copied, offset));
			let opening = stack.length - 1;
			while (opening >= 0 && !bracket.closes(stack[opening]!)) opening--;
			if (opening >= 0) {
				while (stack.length - 1 > opening) parts.push(closingText(stack.pop()!));
				stack.pop();
				parts.push(match[0]);
			}
			copied = offset + match[0].length;
		}
	}
	parts.push(text.slice(copied));
	while (stack.length) parts.push(closingText(stack.pop()!));
	return parts.join('');
}

function includesBrackets(tokens: IViewLineTokens, index: number): boolean {
	return tokens.getStandardTokenType(index) === StandardTokenType.Other && (tokens.getMetadata(index) & MetadataConsts.BALANCED_BRACKETS_MASK) !== 0;
}

function closingText(opening: OpeningBracketKind): string {
	return opening.openedBrackets.values().next().value!.bracketText;
}
