import type { IColorTheme } from '../../../platform/theme/common/themeService.js';
import type { LanguageToken, ResolvedSemanticToken } from '../tokens/languageTokens.js';

/** Resolves one presentation for both DOM text and GPU glyphs; explicit false flags clear syntax styles. */
export function resolveSemanticTokenPresentation(token: ResolvedSemanticToken, theme: IColorTheme, enabled: boolean): NonNullable<LanguageToken['presentation']> {
	const syntax = token.syntaxPresentation ?? {};
	const semantic = enabled && token.semanticType ? theme.getTokenStyleMetadata(token.semanticType, token.semanticModifiers ?? [], token.semanticLanguage ?? '') : undefined;
	const foreground = semantic?.foreground === undefined ? syntax.foreground : theme.tokenColorMap[semantic.foreground];
	const flags = new Set(syntax.fontStyle ?? []);
	let hasStyle = syntax.fontStyle !== undefined;
	for (const property of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
		if (semantic?.[property] !== undefined) {
			hasStyle = true;
			if (semantic[property]) { flags.add(property); } else { flags.delete(property); }
		}
	}
	return { ...syntax, foreground, ...(hasStyle ? { fontStyle: [...flags] } : {}) };
}
