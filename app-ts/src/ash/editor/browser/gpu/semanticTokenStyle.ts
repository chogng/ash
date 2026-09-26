import { Color } from '../../../base/common/color.js';
import { semanticTokenRuleSpecificity, type IColorTheme, type ISemanticTokenThemeRule } from '../../../platform/theme/common/themeService.js';
import { FontStyle, MetadataConsts, TokenMetadata } from '../../common/encodedTokenAttributes.js';
import type { ResolvedSemanticToken } from '../../common/tokens/languageTokens.js';

export interface SemanticGlyphStyle {
	readonly tokenMetadata: number;
	readonly color: number | undefined;
}

/** Resolves semantic rules in the same specificity and source order as the editor's CSS rules. */
export class SemanticTokenStyleResolver {
	private readonly rules: readonly ISemanticTokenThemeRule[];

	constructor(theme: IColorTheme, private readonly enabled: boolean) {
		this.rules = [...theme.semanticTokenRules ?? []].sort((left, right) => semanticTokenRuleSpecificity(left) - semanticTokenRuleSpecificity(right));
	}

	resolve(token: ResolvedSemanticToken | undefined, tokenMetadata: number): SemanticGlyphStyle {
		if (!token) return { tokenMetadata, color: undefined };
		let foreground = token.syntaxPresentation?.foreground;
		let fontStyle: string | undefined;
		if (this.enabled && token.semanticType) {
			for (const rule of this.rules) {
				if (!matches(rule, token)) continue;
				if (rule.foreground !== undefined) foreground = rule.foreground;
				if (rule.fontStyle !== undefined) fontStyle = rule.fontStyle;
			}
		}
		if (fontStyle !== undefined) {
			const styles = new Set(fontStyle.split(/\s+/u).filter(Boolean));
			let flags = FontStyle.None;
			if (styles.has('italic')) flags |= FontStyle.Italic;
			if (styles.has('bold')) flags |= FontStyle.Bold;
			if (styles.has('underline')) flags |= FontStyle.Underline;
			if (styles.has('strikethrough')) flags |= FontStyle.Strikethrough;
			tokenMetadata = (tokenMetadata & ~MetadataConsts.FONT_STYLE_MASK) | (flags << MetadataConsts.FONT_STYLE_OFFSET);
		}
		if (token.syntaxPresentation?.fontStyle) {
			for (const style of token.syntaxPresentation.fontStyle) {
				const flag = style === 'italic' ? FontStyle.Italic : style === 'bold' ? FontStyle.Bold : style === 'underline' ? FontStyle.Underline : FontStyle.Strikethrough;
				tokenMetadata |= flag << MetadataConsts.FONT_STYLE_OFFSET;
			}
		}
		return { tokenMetadata, color: foreground === undefined ? undefined : Color.Format.CSS.parse(foreground)?.toNumber32Bit() };
	}
}

function matches(rule: ISemanticTokenThemeRule, token: ResolvedSemanticToken): boolean {
	return (rule.type === '*' || rule.type === token.semanticType)
		&& (rule.language === undefined || rule.language === token.semanticLanguage)
		&& rule.modifiers.every(modifier => token.semanticModifiers?.includes(modifier));
}
