import { Range } from '../../common/core/range.js';
import { type TextSnapshot } from '../../common/core/textChange.js';
import { type SyntaxProvider } from '../../common/languages/syntax/syntaxProviders.js';
import { LanguageDiagnosticSeverity } from '../../common/languages/languageResults.js';

/** Payload generator for transport tests; words are opaque data, not language tokens. */
export function testTokens(snapshot: TextSnapshot) {
	return { tokens: snapshot.getText().split('\n').flatMap((line, index) =>
		[...line.matchAll(/\S+/gu)].map(word => ({
			range: new Range(index + 1, word.index + 1, index + 1, word.index + word[0].length + 1),
			tokenType: word[0], modifiers: [],
		}))) };
}

export function testDiagnostics(snapshot: TextSnapshot) {
	return { diagnostics: testTokens(snapshot).tokens.map(token => ({
		range: token.range, message: token.tokenType, severity: LanguageDiagnosticSeverity.Warning,
	})) };
}

export function testSyntaxProvider(): SyntaxProvider {
	return {
		id: 'test.payloads', languageIds: ['typescript'],
		provideTokens: request => testTokens(request.snapshot),
		provideDiagnostics: request => testDiagnostics(request.snapshot),
	};
}
