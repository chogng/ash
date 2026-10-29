import { getDocument } from '../../../base/browser/dom.js';
import { renderMarkdown, type IRenderedMarkdown, type MarkdownRenderOptions } from '../../../base/browser/markdownRenderer.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import type { IMarkdownString, MarkdownStringTrustedOptions } from '../../../base/common/htmlContent.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IOpenerService } from '../../opener/common/opener.js';

/** A component can supply its own renderer while retaining ownership of the result. */
export interface IMarkdownRenderer {
	render(markdown: IMarkdownString, options?: MarkdownRenderOptions, outElement?: HTMLElement): IRenderedMarkdown;
}

export interface IMarkdownRendererExtraOptions {
	readonly context?: unknown;
	/** Keeps asynchronous code rendering in the same document as the Markdown root. */
	readonly ownerDocument?: Document;
}

export interface IMarkdownCodeBlockRenderer {
	renderCodeBlock(languageAlias: string | undefined, value: string, options: IMarkdownRendererExtraOptions): Promise<HTMLElement>;
}

export const IMarkdownRendererService = createDecorator<IMarkdownRendererService>('markdownRendererService');

/** Adds shared opening policy and an editor-provided default to the service-free DOM renderer. */
export interface IMarkdownRendererService extends IMarkdownRenderer {
	readonly _serviceBrand: undefined;
	render(markdown: IMarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions, outElement?: HTMLElement): IRenderedMarkdown;
	setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void;
}

export class MarkdownRendererService implements IMarkdownRendererService {
	declare readonly _serviceBrand: undefined;
	private codeBlocks: IMarkdownCodeBlockRenderer | undefined;

	constructor(@IOpenerService private readonly opener: IOpenerService) { }

	render(markdown: IMarkdownString, options: MarkdownRenderOptions & IMarkdownRendererExtraOptions = {}, outElement?: HTMLElement): IRenderedMarkdown {
		const ownerDocument = outElement?.ownerDocument ?? options.ownerDocument ?? getDocument();
		const renderer = this.codeBlocks;
		// Per-render code editors and synchronous placeholders take precedence over the default.
		const codeBlockRenderer = options.codeBlockRenderer ?? (!options.codeBlockRendererSync && renderer
			? (languageId: string, value: string) => renderer.renderCodeBlock(languageId, value, { ...options, ownerDocument })
			: undefined);
		return renderMarkdown(markdown, {
			...options,
			ownerDocument,
			codeBlockRenderer,
			actionHandler: options.actionHandler ?? ((href, source) => { void openLinkFromMarkdown(this.opener, href, source.isTrusted); }),
		}, outElement);
	}

	setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void {
		this.codeBlocks = renderer;
	}
}

/** Trust is carried into the opener even when a caller supplies an already sanitized link. */
export async function openLinkFromMarkdown(openerService: IOpenerService, link: string, isTrusted: boolean | MarkdownStringTrustedOptions | undefined, skipValidation?: boolean): Promise<boolean> {
	const allowCommands = isTrusted === true ? true : isTrusted ? isTrusted.enabledCommands : false;
	try {
		return await openerService.open(link, {
			fromUserGesture: true,
			allowContributedOpeners: true,
			allowCommands,
			skipValidation,
		});
	} catch (error) {
		onUnexpectedError(error);
		return false;
	}
}

registerSingleton(IMarkdownRendererService, MarkdownRendererService, InstantiationType.Delayed);
