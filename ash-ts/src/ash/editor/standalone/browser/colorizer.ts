import { Color } from '../../../base/common/color.js';
import { createTrustedTypesPolicy } from '../../../base/browser/trustedTypes.js';
import { TokenizationRegistry } from '../../common/languages.js';
import type { ILanguageService } from '../../common/languages/language.js';
import { tokenizeLineToHTML } from '../../common/languages/textToHtmlTokenizer.js';
import { LineTokens, type IViewLineTokens } from '../../common/tokens/lineTokens.js';
import type { IStandaloneThemeService } from '../common/standaloneTheme.js';
import { MonarchTokenizer } from '../common/monarch/monarchLexer.js';

const htmlPolicy = createTrustedTypesPolicy('ashStandaloneColorizer', { createHTML: value => value });

export interface IColorizerOptions {
	tabSize?: number;
}

export interface IColorizerElementOptions extends IColorizerOptions {
	theme?: string;
	mimeType?: string;
}

export class Colorizer {
	public static async colorizeElement(themeService: IStandaloneThemeService, languageService: ILanguageService, domNode: HTMLElement, options: IColorizerElementOptions): Promise<void> {
		const language = options.mimeType ?? domNode.getAttribute('lang') ?? domNode.getAttribute('data-lang');
		if (!language) {
			throw new TypeError('Colorized elements require a language');
		}
		themeService.setTheme(options.theme ?? 'vs');
		const languageId = languageService.getLanguageIdByMimeType(language) ?? language;
		const html = await Colorizer.colorize(languageService, domNode.textContent ?? '', languageId, options);
		domNode.innerHTML = htmlPolicy?.createHTML?.(html) ?? html;
	}

	public static async colorize(languageService: ILanguageService, text: string, languageId: string, options: IColorizerOptions | null | undefined): Promise<string> {
		const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
		const tabSize = options?.tabSize ?? 4;
		if (!Number.isSafeInteger(tabSize) || tabSize < 1) {
			throw new RangeError('Colorizer tab size must be a positive integer');
		}
		let support = null;
		if (languageService.isRegisteredLanguageId(languageId)) {
			languageService.requestBasicLanguageFeatures(languageId);
			support = await TokenizationRegistry.getOrCreate(languageId);
		}
		for (;;) {
			let state = support?.getInitialState();
			const html = lines.map((line, index) => {
				let tokens: LineTokens;
				if (support) {
					if (!support.tokenizeEncoded) {
						throw new TypeError('HTML colorization requires an encoded token provider');
					}
					const result = support.tokenizeEncoded(line, index < lines.length - 1, state!);
					state = result.endState;
					if (result.tokens.length > 0) {
						const data = result.tokens.slice();
						LineTokens.convertToEndOffset(data, line.length);
						tokens = new LineTokens(data, line, languageService.languageIdCodec);
					} else {
						tokens = LineTokens.createEmpty(line, languageService.languageIdCodec);
					}
				} else {
					tokens = LineTokens.createEmpty(line, languageService.languageIdCodec);
				}
				return Colorizer.colorizeLine(line, true, true, tokens, tabSize);
			});
			if (support instanceof MonarchTokenizer) {
				const status = support.getLoadStatus();
				if (!status.loaded) {
					await status.promise;
					continue;
				}
			}
			return html.join('<br/>');
		}
	}

	public static colorizeLine(line: string, _mightContainNonBasicASCII: boolean, _mightContainRTL: boolean, tokens: IViewLineTokens, tabSize = 4): string {
		const colors = TokenizationRegistry.getColorMap()?.map(color => Color.Format.CSS.formatHexA(color, true)) ?? [];
		return tokenizeLineToHTML(line, tokens, colors, 0, line.length, tabSize, true);
	}
}
