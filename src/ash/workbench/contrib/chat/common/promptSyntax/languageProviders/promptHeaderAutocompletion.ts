import { Range } from '../../../../../../editor/common/core/range.js';
import {
	LanguageCompletionItemKind,
	type LanguageCompletionProvider,
	type LanguageCompletionProviderRequest,
	type LanguageCompletionProviderResult,
} from '../../../../../../editor/common/languages.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getAttributeDefinition, getValidAttributeNames } from './promptFileAttributes.js';
import { localize } from '../../../../../../nls.js';

/** Offers only the root keys accepted by Ash's Skill catalog, through Stanza's provider contract. */
export class PromptHeaderAutocompletion implements LanguageCompletionProvider {
	public readonly id = 'ash.prompt.skillHeader';
	public readonly languageIds = ['markdown'];
	private readonly parser = new PromptFileParser();

	public provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): LanguageCompletionProviderResult | undefined {
		if (signal.aborted || !request.resource?.path.endsWith('/SKILL.md')) return undefined;
		const source = request.snapshot.getText();
		const parsed = this.parser.parse(request.resource, source);
		if (!parsed.header?.range.containsPosition(request.position)) return undefined;
		const lines = source.split(/\r\n|\n|\r/u);
		const line = lines[request.position.lineNumber - 1]!;
		const prefix = line.slice(0, request.position.column - 1);
		if (!/^[a-z-]*$/u.test(prefix) || !/^[a-z-]*$/u.test(line)) return undefined;
		const existing = new Set(lines.slice(1, parsed.header.range.endLineNumber).flatMap(line => {
			const match = /^([a-z][a-z-]*):/u.exec(line);
			return match ? [match[1]!] : [];
		}));
		const range = new Range(request.position.lineNumber, 1, request.position.lineNumber, line.length + 1);
		return {
			items: getValidAttributeNames().filter(name => name.startsWith(prefix) && !existing.has(name)).map((name, index) => ({
				id: name, label: name, insertText: `${name}: `, range,
				kind: LanguageCompletionItemKind.Property,
				detail: localize('prompt.skill.field', 'Skill field'), documentation: getAttributeDefinition(name)!.description,
				sortText: String(index).padStart(2, '0'),
			})),
			isIncomplete: true,
		};
	}
}
