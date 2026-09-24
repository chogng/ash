import { URI } from './uri.js';

export interface MarkdownStringTrustedOptions {
	readonly enabledCommands?: readonly string[];
}

export interface IMarkdownString {
	readonly value: string;
	readonly isTrusted?: boolean | MarkdownStringTrustedOptions;
	readonly supportThemeIcons?: boolean;
	readonly supportHtml?: boolean;
	readonly baseUri?: URI;
}

export class MarkdownString implements IMarkdownString {
	value: string;
	isTrusted: boolean | MarkdownStringTrustedOptions | undefined;
	supportThemeIcons: boolean;
	supportHtml: boolean;
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
		this.baseUri = typeof options === 'boolean' ? undefined : options.baseUri;
	}

	appendText(value: string): this {
		this.value += escapeMarkdownSyntaxTokens(value).replace(/([ \t]+)/g, spaces => '&nbsp;'.repeat(spaces.length)).replace(/\n/g, '\n\n');
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
		&& (candidate.isTrusted === undefined || typeof candidate.isTrusted === 'boolean' || typeof candidate.isTrusted === 'object')
		&& (candidate.supportThemeIcons === undefined || typeof candidate.supportThemeIcons === 'boolean')
		&& (candidate.supportHtml === undefined || typeof candidate.supportHtml === 'boolean');
}

export function escapeMarkdownSyntaxTokens(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+!~]/g, '\\$&').replace(/^([ \t]*)-/gm, '$1\\-');
}

function escapedCodeBlock(code: string, languageId: string): string {
	const longest = Math.max(0, ...(code.match(/^`+/gm) ?? []).map(match => match.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}${languageId}\n${code}\n${fence}`;
}
