import { Position } from "../../../../../../editor/common/core/position.js";
import { Range } from "../../../../../../editor/common/core/range.js";
import { LanguageCompletionItemKind, type LanguageCompletionProvider, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from '../../../../../../editor/common/languages.js';

import type { SkillSelectorCatalog } from "../../../common/skillSelectors.js";
import { CHAT_INPUT_LANGUAGE_ID } from "./chatCommandCompletion.js";

/** Adapts the Chat Skill catalog to the `$skill` completion contract. */
export function createChatSkillCompletionProvider(catalog: SkillSelectorCatalog): LanguageCompletionProvider {
	return Object.freeze({
		id: "ash.chat.skills",
		languageIds: Object.freeze([CHAT_INPUT_LANGUAGE_ID]),
		triggerCharacters: Object.freeze(["$"]),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			const line = request.snapshot.getText().split("\n")[request.position.lineNumber - 1] ?? "";
			const token = activeSkillToken(line, request.position.column - 1);
			if (!token) {
				return emptyCompletionResult();
			}
			const matches = catalog.matching(token.query);
			const range = Range.fromPositions(
				new Position(request.position.lineNumber, token.startColumn + 1),
				new Position(request.position.lineNumber, token.endColumn + 1),
			);
			return Object.freeze({
				items: Object.freeze(matches.map((skill, index) => Object.freeze({
					id: `${skill.source}:${skill.name}`,
					label: `$${skill.name}`,
					kind: LanguageCompletionItemKind.Reference,
					range,
					insertText: `$${skill.name} `,
					detail: skill.description,
					filterText: `$${skill.name}`,
					sortText: skill.name,
					...(index === 0 ? { preselect: true } : {}),
				}))),
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
	const startColumn = prefix.lastIndexOf("$");
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

function emptyCompletionResult(): LanguageCompletionProviderResult {
	return Object.freeze({ items: Object.freeze([]), isIncomplete: false });
}
