import { SemanticTokenModifier, SemanticTokenPresentation, type LanguageToken, type SemanticTokenStyling, type SemanticTokenStylingResolver } from '../tokens/languageTokens.js';
import type { DocumentTokensProvider } from './semanticTokensStyling.js';

/** Resolves the object-token vocabulary for one semantic-token provider. */
export class SemanticTokensProviderStyling implements SemanticTokenStylingResolver {
	constructor(readonly provider: DocumentTokensProvider) {
		if (!provider || typeof provider.provideSemanticTokens !== 'function') {
			throw new TypeError('Semantic token styling requires a document token provider');
		}
	}

	public resolve(token: LanguageToken): SemanticTokenStyling {
		return resolveSemanticTokenStyling(token);
	}
}

export function resolveSemanticTokenStyling(token: LanguageToken): SemanticTokenStyling {
	const presentation = resolveSemanticTokenPresentation(token);
	const modifiers = resolveSemanticTokenModifiers(token);
	return Object.freeze({ ...(presentation === undefined ? {} : { presentation }), modifiers });
}

function resolveSemanticTokenPresentation(token: LanguageToken): SemanticTokenPresentation | undefined {
	switch (token.tokenType) {
		case 'comment': return SemanticTokenPresentation.Comment;
		case 'keyword':
		case 'modifier': return SemanticTokenPresentation.Keyword;
		case 'string': return SemanticTokenPresentation.String;
		case 'number': return SemanticTokenPresentation.Number;
		case 'regexp': return SemanticTokenPresentation.Regexp;
		case 'class':
		case 'enum':
		case 'interface':
		case 'namespace':
		case 'struct':
		case 'type':
		case 'typeParameter': return SemanticTokenPresentation.Type;
		case 'function':
		case 'method': return SemanticTokenPresentation.Function;
		case 'enumMember':
		case 'event':
		case 'parameter':
		case 'property':
		case 'variable': return SemanticTokenPresentation.Variable;
		case 'operator': return SemanticTokenPresentation.Operator;
		default: return undefined;
	}
}

function resolveSemanticTokenModifiers(token: LanguageToken): readonly SemanticTokenModifier[] {
	const resolved = new Set<SemanticTokenModifier>();
	for (const modifier of token.modifiers) {
		switch (modifier) {
			case 'declaration':
			case 'definition': resolved.add(SemanticTokenModifier.Declaration); break;
			case 'readonly': resolved.add(SemanticTokenModifier.Readonly); break;
			case 'static': resolved.add(SemanticTokenModifier.Static); break;
			case 'deprecated': resolved.add(SemanticTokenModifier.Deprecated); break;
			case 'abstract': resolved.add(SemanticTokenModifier.Abstract); break;
			case 'async': resolved.add(SemanticTokenModifier.Async); break;
		}
	}
	return Object.freeze([...resolved]);
}
