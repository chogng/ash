import type { URI } from '../../../../base/common/uri.js';
import { parseSnippet } from '../../../../../../extensions/code/browser/contrib/snippet/common/snippetParser.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import type { ExtensionSnippetFile } from '../../../services/extensions/common/extensionService.js';

export class Snippet {
	constructor(
		public readonly isFileTemplate: boolean,
		public readonly scopes: readonly string[],
		public readonly name: string,
		public readonly prefix: string,
		public readonly description: string,
		public readonly body: string,
		public readonly snippetIdentifier: string,
	) {
		Object.freeze(this);
	}
}

/** Parses one extension resource into immutable, independently completable prefixes. */
export class SnippetFile {
	public readonly data: readonly Snippet[];
	public readonly location: URI;

	constructor(resource: ExtensionSnippetFile) {
		this.location = resource.location;
		const owner = `Extension '${resource.extensionId}' snippet file '${resource.location.path}'`;
		const contents = objectValue(parseJsonc(resource.content, owner), owner);
		const snippets: Snippet[] = [];
		for (const [name, value] of Object.entries(contents)) {
			const entryOwner = `${owner}.${name}`;
			const entry = objectValue(value, entryOwner);
			textValue(name, `${owner} name`, 256);
			if (entry.isFileTemplate !== undefined && typeof entry.isFileTemplate !== 'boolean') {
				throw new TypeError(`${entryOwner}.isFileTemplate must be a boolean`);
			}
			const body = multilineValue(entry.body, `${entryOwner}.body`, 1024 * 1024);
			parseSnippet(body, { allowUnresolvedVariables: true });
			const description = entry.description === undefined ? '' : multilineValue(entry.description, `${entryOwner}.description`, 512);
			const prefixes = entry.prefix === undefined ? [''] : textList(entry.prefix, `${entryOwner}.prefix`, 128);
			const declaredScopes = entry.scope === undefined ? undefined : textList(entry.scope, `${entryOwner}.scope`, 128).flatMap(scope => scope.split(',').map(language => language.trim()));
			const scopes = Object.freeze(resource.languageIds.filter(language => !declaredScopes || declaredScopes.includes(language)));
			for (const prefix of new Set(prefixes)) {
				snippets.push(new Snippet(entry.isFileTemplate === true, scopes, name, prefix, description, body, JSON.stringify([resource.extensionId, resource.location.path, name, prefix])));
			}
		}
		this.data = Object.freeze(snippets);
	}
}

function objectValue(value: unknown, owner: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${owner} must be an object`);
	}
	return value as Record<string, unknown>;
}

function textValue(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== 'string' || value.length > maximum || /[\r\n]/u.test(value)) {
		throw new TypeError(`${owner} must be bounded text`);
	}
	return value;
}

function textList(value: unknown, owner: string, maximum: number): string[] {
	if (typeof value === 'string') {
		return [textValue(value, owner, maximum)];
	}
	if (!Array.isArray(value)) {
		throw new TypeError(`${owner} must be a string or string array`);
	}
	return value.map(entry => textValue(entry, owner, maximum));
}

function multilineValue(value: unknown, owner: string, maximum: number): string {
	const text = typeof value === 'string' ? value : textList(value, owner, maximum).join('\n');
	if (text.length > maximum) {
		throw new RangeError(`${owner} is too large`);
	}
	return text;
}
