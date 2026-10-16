import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { SanitizeAttributeRule } from '../../../../base/browser/domSanitize.js';
import type { MarkdownSanitizerConfig } from '../../../../base/browser/markdownRenderer.js';
import type { CodeWindow } from '../../../../base/browser/window.js';
import type { MarkedExtension } from '../../../../base/common/marked/marked.js';
import { katexContainerLatexAttributeName, MarkedKatexExtension } from '../common/markedKatexExtension.js';

const mathTags = ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'msub', 'msup', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'menclose', 'mstyle', 'mpadded', 'mphantom', 'mmultiscripts', 'mprescripts', 'none', 'svg', 'path', 'line', 'text', 'title', 'desc'];
const mathAttributes = ['xmlns', 'display', 'stretchy', 'fence', 'separator', 'mathvariant', 'displaystyle', 'scriptlevel', 'lspace', 'rspace', 'movablelimits', 'accent', 'accentunder', 'columnalign', 'columnspacing', 'rowspacing', 'linethickness', 'encoding', 'd', 'viewBox', 'preserveAspectRatio', katexContainerLatexAttributeName];
const styleProperties = new Set(['color', 'background-color', 'display', 'top', 'left', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding-left', 'padding-right', 'vertical-align', 'font-size', 'font-style', 'font-weight', 'text-align', 'border-width', 'border-bottom-width', 'border-top-width', 'border-right-width', 'border-color', 'border-style']);

/** Owns the math extension's rendering dependency and the extra markup it needs to survive sanitization. */
export class MarkedKatexSupport {
	public static getSanitizerOptions(baseConfig: { readonly allowedTags: readonly string[]; readonly allowedAttributes: ReadonlyArray<string | SanitizeAttributeRule>; }): MarkdownSanitizerConfig {
		return {
			allowedTags: { override: [...new Set([...baseConfig.allowedTags, ...mathTags])] },
			allowedAttributes: {
				override: [...baseConfig.allowedAttributes, ...mathAttributes, {
					attributeName: 'style', shouldKeep: (_element, data) => {
						// Keep only bounded numeric/keyword declarations. URL-bearing CSS,
						// custom properties, expressions and arbitrary functions never reach DOM.
						return data.attrValue.split(';').flatMap(declaration => {
							const separator = declaration.indexOf(':');
							const property = declaration.slice(0, separator).trim().toLowerCase();
							const value = declaration.slice(separator + 1).trim();
							return styleProperties.has(property) && /^(?:-?(?:\d*\.)?\d+(?:em|ex|px|pt|rem|%)?|[a-z-]+|#[\da-f]{3,8})(?:\s+(?:-?(?:\d*\.)?\d+(?:em|ex|px|pt|rem|%)?|[a-z-]+)){0,3}$/iu.test(value) ? [`${property}:${value}`] : [];
						}).join(';');
					},
				}]
			},
		};
	}

	public static getExtension(_window: CodeWindow, options: MarkedKatexExtension.MarkedKatexOptions = {}): MarkedExtension {
		// The package and its CSS are bundled in each renderer, so this entry is
		// synchronous and does not introduce a second async rendering lifetime.
		return MarkedKatexExtension.extension(katex, options);
	}
}
