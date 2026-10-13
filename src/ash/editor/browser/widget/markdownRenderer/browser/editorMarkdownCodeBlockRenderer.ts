import { getDocument, h } from '../../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';
import type { IMarkdownCodeBlockRenderer, IMarkdownRendererExtraOptions } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ILanguageService } from '../../../../common/languages/language.js';
import { Colorizer } from '../../../../standalone/browser/colorizer.js';

const codePolicy = createTrustedTypesPolicy('ashMarkdownCodeBlocks', { createHTML: value => value });

/** Uses the existing editor tokenizer without creating a code model or editor widget. */
export class EditorMarkdownCodeBlockRenderer implements IMarkdownCodeBlockRenderer {
	constructor(@ILanguageService private readonly languages: ILanguageService) { }

	async renderCodeBlock(languageAlias: string | undefined, value: string, options: IMarkdownRendererExtraOptions): Promise<HTMLElement> {
		const code = h(options.ownerDocument ?? getDocument(), 'code');
		const languageId = languageAlias
			? this.languages.getLanguageIdByLanguageName(languageAlias) ?? languageAlias
			: 'plaintext';
		const html = await Colorizer.colorize(this.languages, value, languageId, {});
		code.innerHTML = codePolicy?.createHTML?.(html) ?? html;
		return code;
	}
}
