import { URI } from './uri.js';
import { escapeIcons } from './iconLabels.js';

export interface MarkdownStringTrustedOptions {
	readonly enabledCommands?: readonly string[];
}

export interface IMarkdownString {
	readonly value: string;
	readonly isTrusted?: boolean | MarkdownStringTrustedOptions;
	readonly supportThemeIcons?: boolean;
	readonly supportHtml?: boolean;
	readonly supportAlertSyntax?: boolean;
	readonly baseUri?: URI;
}

export class MarkdownString implements IMarkdownString {
	value: string;
	isTrusted: boolean | MarkdownStringTrustedOptions | undefined;
	supportThemeIcons: boolean;
	supportHtml: boolean;
	supportAlertSyntax: boolean;
	baseUri: URI | undefined;

	static lift(value: IMarkdownString): MarkdownString {
		const result = new MarkdownString(value.value, value);
		result.baseUri = value.baseUri;
		return result;
	}

	constructor(value = '', options: boolean | Omit<IMarkdownString, 'value'> = false) {
		if (typeof value !== 'string') throw new TypeError('Markdown value must be a string');
		this.value = value;
		this.isTrusted = typeof options === 'boolean' ? options : options.isTrusted;
		this.supportThemeIcons = typeof options === 'boolean' ? false : options.supportThemeIcons ?? false;
		this.supportHtml = typeof options === 'boolean' ? false : options.supportHtml ?? false;
		this.supportAlertSyntax = typeof options === 'boolean' ? false : options.supportAlertSyntax ?? false;
		this.baseUri = typeof options === 'boolean' ? undefined : options.baseUri;
	}

	appendText(value: string): this {
		const escaped = escapeMarkdownSyntaxTokens(this.supportThemeIcons ? escapeIcons(value) : value);
		this.value += escaped.replace(/([ \t]+)/g, spaces => '&nbsp;'.repeat(spaces.length)).replace(/\n/g, '\n\n');
		return this;
	}

	appendMarkdown(value: string): this { this.value += value; return this; }
	appendCodeblock(languageId: string, code: string): this { this.value += `\n${escapedCodeBlock(code, languageId)}\n`; return this; }
	appendLink(target: URI | string, label: string, title?: string): this {
		const escapedLabel = label.replace(/[\\\]]/g, '\\$&');
		const escapedTarget = String(target).replace(/[\\)]/g, '\\$&');
		const escapedTitle = title?.replace(/[\\"]/g, '\\$&');
		this.value += `[${escapedLabel}](${escapedTarget}${escapedTitle ? ` "${escapedTitle}"` : ''})`;
		return this;
	}
}

export function isMarkdownString(value: unknown): value is IMarkdownString {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as IMarkdownString;
	return typeof candidate.value === 'string'
		&& isMarkdownStringTrust(candidate.isTrusted)
		&& (candidate.supportThemeIcons === undefined || typeof candidate.supportThemeIcons === 'boolean')
		&& (candidate.supportHtml === undefined || typeof candidate.supportHtml === 'boolean')
		&& (candidate.supportAlertSyntax === undefined || typeof candidate.supportAlertSyntax === 'boolean')
		&& (candidate.baseUri === undefined || candidate.baseUri instanceof URI);
}

function isMarkdownStringTrust(value: unknown): boolean {
	if (value === undefined || typeof value === 'boolean') return true;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const enabledCommands = (value as MarkdownStringTrustedOptions).enabledCommands;
	return enabledCommands === undefined
		|| Array.isArray(enabledCommands) && enabledCommands.every(command => typeof command === 'string');
}

export function escapeMarkdownSyntaxTokens(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+!~]/g, '\\$&').replace(/^([ \t]*)-/gm, '$1\\-');
}

export function parseHrefAndDimensions(href: string): { href: string; dimensions: string[] } {
	const [source, parameters = ''] = href.split('|', 2);
	const dimensions: string[] = [];
	for (const name of ['width', 'height'] as const) {
		const match = new RegExp(`(?:^|[,\\s])${name}=(\\d+)`).exec(parameters);
		if (match) {
			dimensions.push(`${name}="${match[1]}"`);
		}
	}
	return { href: source!.trim(), dimensions };
}

function escapedCodeBlock(code: string, languageId: string): string {
	const longest = Math.max(0, ...(code.match(/^`+/gm) ?? []).map(match => match.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}${languageId}\n${code}\n${fence}`;
}
