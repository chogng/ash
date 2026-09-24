import { TokenizationRegistry } from '../../common/languages.js';

/** Registers declared token boundaries for exact fixture lines. */
export function registerTestTokens(lines: ReadonlyMap<string, readonly { offset: number; type: string }[]>, languageId = 'typescript') {
	const state = { clone() { return this; }, equals(other: unknown) { return other === this; } };
	return TokenizationRegistry.register(languageId, {
		getInitialState: () => state,
		tokenize: line => ({
			tokens: (lines.get(line) ?? [{ offset: 0, type: '' }]).map(token => ({ ...token, language: languageId })),
			endState: state,
		}),
	});
}
