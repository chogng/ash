import { Color } from '../../../base/common/color.js';
import { type IColorTheme } from '../../../platform/theme/common/themeService.js';
import { resolveSemanticTokenPresentation } from '../../common/services/semanticTokensStyling.js';
import { FontStyle, MetadataConsts } from '../../common/encodedTokenAttributes.js';
import type { ResolvedSemanticToken } from '../../common/tokens/languageTokens.js';

export interface SemanticGlyphStyle {
	readonly tokenMetadata: number;
	readonly color: number | undefined;
}

/** Encodes the shared editor presentation into GPU glyph metadata. */
export class SemanticTokenStyleResolver {
	constructor(private readonly theme: IColorTheme, private readonly enabled: boolean) { }

	public resolve(token: ResolvedSemanticToken | undefined, tokenMetadata: number): SemanticGlyphStyle {
		if (!token) { return { tokenMetadata, color: undefined }; }
		const presentation = resolveSemanticTokenPresentation(token, this.theme, this.enabled);
		if (presentation.fontStyle !== undefined) {
			let flags = FontStyle.None;
			for (const style of presentation.fontStyle) {
				flags |= style === 'italic' ? FontStyle.Italic : style === 'bold' ? FontStyle.Bold : style === 'underline' ? FontStyle.Underline : FontStyle.Strikethrough;
			}
			tokenMetadata = (tokenMetadata & ~MetadataConsts.FONT_STYLE_MASK) | (flags << MetadataConsts.FONT_STYLE_OFFSET);
		}
		return { tokenMetadata, color: presentation.foreground === undefined ? undefined : Color.Format.CSS.parse(presentation.foreground)?.toNumber32Bit() };
	}
}
