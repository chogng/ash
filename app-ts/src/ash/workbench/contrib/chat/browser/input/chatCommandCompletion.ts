import { LanguageCompletionItemKind, type LanguageCompletionProvider, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from '../../../../../editor/common/languages.js';

import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type SlashCommandCatalog } from "../../common/slashCommands.js";

export const CHAT_INPUT_LANGUAGE_ID = "ash-chat-input";

/** Adapts the Chat slash-command catalog to Stanza's completion contract. */
export function createChatCommandCompletionProvider(catalog: SlashCommandCatalog): LanguageCompletionProvider {
	return Object.freeze({
		id: "ash.chat.commands",
		languageIds: Object.freeze([CHAT_INPUT_LANGUAGE_ID]),
		triggerCharacters: Object.freeze(["/"]),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			if (request.position.lineNumber !== 1) return undefined;
			const line = request.snapshot.getText().split("\n", 1)[0] ?? "";
			const prefix = line.slice(0, request.position.column - 1);
			if (!prefix.startsWith("/") || /\s/.test(prefix)) return emptyCompletionResult();
			const query = prefix.slice(1);
			const matches = catalog.matching(query);
			const commandEnd = line.search(/\s|$/);
			const replacementEnd = commandEnd + (line[commandEnd] === " " ? 1 : 0);
			const range = Range.fromPositions(new Position(1, 1), new Position(1, replacementEnd + 1));
			return Object.freeze({
				items: Object.freeze(matches.map((command, index) => Object.freeze({
					id: command.name,
					label: `/${command.name}`,
					kind: LanguageCompletionItemKind.Function,
					range,
					insertText: `/${command.name} `,
					detail: command.description,
					filterText: `/${command.name}`,
					sortText: command.name,
					...(index === 0 ? { preselect: true } : {}),
				}))),
				isIncomplete: true,
			});
		},
	});
}

function emptyCompletionResult(): LanguageCompletionProviderResult {
	return Object.freeze({ items: Object.freeze([]), isIncomplete: false });
}
