import {
	LanguageCompletionItemKind,
	type LanguageCompletionProvider,
	type LanguageCompletionProviderRequest,
	type LanguageCompletionProviderResult,
} from '../../../../../../../editor/common/languages.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { matchedCharacterIndices, type SlashCommandCatalog } from '../../../../common/slashCommands.js';
import type { SkillSelectorCatalog } from '../../../../common/skillSelectors.js';

export const CHAT_INPUT_LANGUAGE_ID = 'ash-chat-input';

/** Adapts the Chat slash-command catalog to Stanza's completion contract. */
export function createChatCommandCompletionProvider(catalog: SlashCommandCatalog): LanguageCompletionProvider {
	return Object.freeze({
		id: 'ash.chat.commands',
		languageIds: Object.freeze([CHAT_INPUT_LANGUAGE_ID]),
		triggerCharacters: Object.freeze(['/']),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			if (request.position.lineNumber !== 1) return undefined;
			const line = request.snapshot.getText().split('\n', 1)[0] ?? '';
			const prefix = line.slice(0, request.position.column - 1);
			if (!prefix.startsWith('/') || /\s/.test(prefix)) return emptyCompletionResult();
			const query = prefix.slice(1);
			const matches = catalog.matching(query);
			// Weak name and description matches need an explicit choice before Enter can accept them.
			const selectFirst = !query || (matches[0]?.name.startsWith(query.toLowerCase()) ?? false);
			const commandEnd = line.search(/\s|$/);
			const replacementEnd = commandEnd + (line[commandEnd] === ' ' ? 1 : 0);
			const range = Range.fromPositions(new Position(1, 1), new Position(1, replacementEnd + 1));
			return Object.freeze({
				items: Object.freeze(
					matches.map((command, index) =>
						Object.freeze({
							id: command.name,
							label: `/${command.name}`,
							labelMatchIndices: matchedCharacterIndices(command.name, query).map(position => position + 1),
							kind: LanguageCompletionItemKind.Function,
							range,
							insertText: `/${command.name} `,
							detail: command.description,
							detailMatchIndices: matchedCharacterIndices(command.description, query),
							filterText: `/${command.name}`,
							sortText: command.name,
							preselect: selectFirst && index === 0,
						}),
					),
				),
				isIncomplete: true,
			});
		},
	});
}

function emptyCompletionResult(): LanguageCompletionProviderResult {
	return Object.freeze({ items: Object.freeze([]), isIncomplete: false });
}

interface ChatSkillCompletionOptions {
	readonly id: string;
	readonly languageId: string;
}

/** Adapts the Chat Skill catalog to the `$skill` completion contract. */
export function createChatSkillCompletionProvider(
	catalog: SkillSelectorCatalog,
	options: ChatSkillCompletionOptions = { id: 'ash.chat.skills', languageId: CHAT_INPUT_LANGUAGE_ID },
): LanguageCompletionProvider {
	return Object.freeze({
		id: options.id,
		languageIds: Object.freeze([options.languageId]),
		triggerCharacters: Object.freeze(['$']),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			const line = request.snapshot.getText().split('\n')[request.position.lineNumber - 1] ?? '';
			const token = activeSkillToken(line, request.position.column - 1);
			if (!token) {
				return emptyCompletionResult();
			}
			const matches = catalog.matching(token.query);
			const range = Range.fromPositions(new Position(request.position.lineNumber, token.startColumn + 1), new Position(request.position.lineNumber, token.endColumn + 1));
			return Object.freeze({
				items: Object.freeze(
					matches.map((skill, index) =>
						Object.freeze({
							id: `${skill.source}:${skill.name}`,
							label: `$${skill.name}`,
							kind: LanguageCompletionItemKind.Reference,
							range,
							insertText: `$${skill.name} `,
							detail: skill.description,
							filterText: `$${skill.name}`,
							sortText: skill.name,
							...(index === 0 ? { preselect: true } : {}),
						}),
					),
				),
				isIncomplete: true,
			});
		},
	});
}

function activeSkillToken(line: string, cursorColumn: number): { readonly query: string; readonly startColumn: number; readonly endColumn: number } | undefined {
	if (cursorColumn > line.length) {
		return undefined;
	}
	const prefix = line.slice(0, cursorColumn);
	const startColumn = prefix.lastIndexOf('$');
	if (startColumn < 0 || (startColumn > 0 && !/\s/.test(line[startColumn - 1]!))) {
		return undefined;
	}
	const query = prefix.slice(startColumn + 1);
	if (!/^[a-z0-9-]*$/.test(query)) {
		return undefined;
	}
	const suffix = line.slice(cursorColumn);
	const suffixLength = suffix.search(/\s|$/);
	const tokenSuffix = suffix.slice(0, suffixLength);
	if (!/^[a-z0-9-]*$/.test(tokenSuffix)) {
		return undefined;
	}
	return { query, startColumn, endColumn: cursorColumn + tokenSuffix.length };
}
