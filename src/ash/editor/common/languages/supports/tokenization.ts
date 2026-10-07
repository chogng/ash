import { Range } from '../../core/range.js';
import { type LanguageToken } from '../../tokens/languageTokens.js';
import { TokenizationRegistry, type ILanguageIdCodec, type Token } from '../../languages.js';
import { Color } from '../../../../base/common/color.js';
import { ColorId, FontStyle, type LanguageId, MetadataConsts, StandardTokenType, TokenMetadata } from '../../encodedTokenAttributes.js';

export interface ITokenThemeRule {
	token: string;
	foreground?: string;
	background?: string;
	fontStyle?: string;
}

interface CompiledRule {
	readonly scope: string;
	readonly foreground?: number;
	readonly background?: number;
	readonly fontStyle?: FontStyle;
}

/** Matches dotted scopes using the most specific value for each style property. */
export class TokenTheme {
	private readonly scopes = new Map<string, number>();

	private constructor(
		private readonly rules: readonly CompiledRule[],
		private readonly colors: readonly Color[],
		private readonly foreground: number,
		private readonly background: number,
	) { }

	public static createFromRawTokenTheme(source: ITokenThemeRule[], customTokenColors: string[]): TokenTheme {
		const colors = [Color.transparent];
		const ids = new Map<string, number>();
		const colorId = (value: string): number => {
			const color = Color.Format.CSS.parseHex(value.startsWith('#') ? value : `#${value}`);
			if (!color) {
				throw new TypeError(`Invalid token color: ${value}`);
			}
			const key = Color.Format.CSS.formatHexA(color, true);
			const existing = ids.get(key);
			if (existing !== undefined) {
				return existing;
			}
			const id = colors.length;
			ids.set(key, id);
			colors.push(color);
			return id;
		};
		for (const color of customTokenColors) {
			colorId(color);
		}
		let defaultForeground = '000000';
		let defaultBackground = 'ffffff';
		for (const rule of source) {
			if (rule.token === '') {
				defaultForeground = rule.foreground ?? defaultForeground;
				defaultBackground = rule.background ?? defaultBackground;
			}
		}
		const foreground = colorId(defaultForeground);
		const background = colorId(defaultBackground);
		const rules = source.map(rule => ({
			scope: rule.token,
			foreground: rule.foreground === undefined ? undefined : colorId(rule.foreground),
			background: rule.background === undefined ? undefined : colorId(rule.background),
			fontStyle: rule.fontStyle === undefined ? undefined : parseFontStyle(rule.fontStyle),
		})).sort((left, right) => left.scope.length - right.scope.length);
		if (colors.length > 512 || background > 255 || rules.some(rule => (rule.background ?? 0) > 255)) {
			throw new RangeError('Token theme exceeds the encoded color limit');
		}
		return new TokenTheme(rules, colors, foreground, background);
	}

	public getColorMap(): Color[] {
		return [...this.colors];
	}

	public match(languageId: LanguageId, token: string): number {
		let style = this.scopes.get(token);
		if (style === undefined) {
			let foreground = this.foreground;
			let background = this.background;
			let fontStyle = FontStyle.None;
			for (const rule of this.rules) {
				if (rule.scope !== '' && token !== rule.scope && !token.startsWith(`${rule.scope}.`)) {
					continue;
				}
				foreground = rule.foreground ?? foreground;
				background = rule.background ?? background;
				fontStyle = rule.fontStyle ?? fontStyle;
			}
			style = ((foreground << MetadataConsts.FOREGROUND_OFFSET)
				| (background << MetadataConsts.BACKGROUND_OFFSET)
				| (fontStyle << MetadataConsts.FONT_STYLE_OFFSET)
				| (toStandardTokenType(token) << MetadataConsts.TOKEN_TYPE_OFFSET)) >>> 0;
			this.scopes.set(token, style);
		}
		return (style | languageId) >>> 0;
	}
}

function parseFontStyle(value: string): FontStyle {
	let result = FontStyle.None;
	for (const style of value.split(/\s+/)) {
		switch (style) {
			case 'italic': result |= FontStyle.Italic; break;
			case 'bold': result |= FontStyle.Bold; break;
			case 'underline': result |= FontStyle.Underline; break;
			case 'strikethrough': result |= FontStyle.Strikethrough; break;
		}
	}
	return result;
}

/** Classifies language scopes without treating a substring inside a word as a token type. */
export function toStandardTokenType(tokenType: string): StandardTokenType {
	for (const scope of tokenType.split(/\W+/u)) {
		switch (scope) {
			case 'comment': return StandardTokenType.Comment;
			case 'string': return StandardTokenType.String;
			case 'regex':
			case 'regexp': return StandardTokenType.RegEx;
		}
	}
	return StandardTokenType.Other;
}

/** Converts provider offsets and encoded styles into the model-owned token representation. */
export function appendLanguageTokens(target: LanguageToken[], tokens: readonly Token[] | Uint32Array, lineNumber: number, line: string, languageIdCodec: ILanguageIdCodec, rawTokens?: readonly Token[]): void {
	if (!(tokens instanceof Uint32Array)) {
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			const end = tokens[index + 1]?.offset ?? line.length;
			if (end > token.offset && token.type) {
				target.push({ range: new Range(lineNumber, token.offset + 1, lineNumber, end + 1), tokenType: token.type, modifiers: token.modifiers ?? [], languageId: token.language, presentation: token.presentation, balancedBrackets: token.balancedBrackets });
			}
		}
		return;
	}
	const codec = languageIdCodec;
	const colors = TokenizationRegistry.getColorMap();
	if (!codec || !colors) {
		throw new ReferenceError('Encoded tokenization requires a language codec and color map');
	}
	if (tokens.length % 2 !== 0) {
		throw new TypeError('Encoded tokens must contain offset and metadata pairs');
	}
	let rawIndex = 0;
	for (let index = 0; index < tokens.length; index += 2) {
		const start = tokens[index]!;
		const end = tokens[index + 2] ?? line.length;
		if (end <= start) {
			continue;
		}
		const metadata = tokens[index + 1]!;
		const type = TokenMetadata.getTokenType(metadata);
		const foreground = TokenMetadata.getForeground(metadata);
		const background = TokenMetadata.getBackground(metadata);
		const style = TokenMetadata.getFontStyle(metadata);
		const fontStyle: NonNullable<LanguageToken['presentation']>['fontStyle'] = [
			...(style & FontStyle.Italic ? ['italic' as const] : []),
			...(style & FontStyle.Bold ? ['bold' as const] : []),
			...(style & FontStyle.Underline ? ['underline' as const] : []),
			...(style & FontStyle.Strikethrough ? ['strikethrough' as const] : []),
		];
		const languageId = codec.decodeLanguageId(TokenMetadata.getLanguageId(metadata));
		const standardType = type === StandardTokenType.Comment ? 'comment' : type === StandardTokenType.String ? 'string' : type === StandardTokenType.RegEx ? 'regexp' : 'other';
		const presentation = {
			foreground: foreground === ColorId.None ? undefined : Color.Format.CSS.formatHexA(colors[foreground]!, true),
			background: background === ColorId.None || background === ColorId.DefaultBackground ? undefined : Color.Format.CSS.formatHexA(colors[background]!, true),
			fontStyle,
		};
		while (rawTokens?.[rawIndex + 1] && rawTokens[rawIndex + 1]!.offset <= start) rawIndex++;
		const append = (from: number, to: number): void => {
			if (to <= from) return;
			const rawToken = rawTokens?.[rawIndex];
			target.push({
				range: new Range(lineNumber, from + 1, lineNumber, to + 1),
				tokenType: rawToken && rawToken.offset <= from && rawToken.language === languageId && rawToken.type ? rawToken.type : standardType,
				modifiers: [],
				languageId,
				...(TokenMetadata.containsBalancedBrackets(metadata) ? {} : { balancedBrackets: false as const }),
				presentation,
			});
		};
		let segmentStart = start;
		while (rawTokens?.[rawIndex + 1] && rawTokens[rawIndex + 1]!.offset < end) {
			const boundary = rawTokens[rawIndex + 1]!.offset;
			append(segmentStart, boundary);
			rawIndex++;
			segmentStart = boundary;
		}
		append(segmentStart, end);
	}
}
