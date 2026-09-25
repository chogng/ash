import { OPEN_LANGUAGE_SERVERS_COMMAND_ID } from "../../../../platform/language/common/languageServerService.js";
import { localize } from "../../../../nls.js";
import { OPEN_SKILLS_COMMAND_ID } from "../../../../platform/skills/common/skillService.js";
import { ProductSlashCommands, type SlashCommandDefinition } from "../../../services/chat/common/chatService.js";
import { NEW_CHAT_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from "./chat.js";

import { OPEN_MARKETPLACE_COMMAND_ID, OPEN_PLUGINS_COMMAND_ID } from "../../../../platform/marketplace/common/marketplaceService.js";

const SLASH_COMMAND_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SlashCommandBinding =
	| { readonly origin: "local"; readonly actionId: string }
	| { readonly origin: "server" };

export type SlashCommandInput =
	| { readonly kind: "message"; readonly text: string }
	| { readonly kind: "unknown"; readonly name: string }
	| { readonly kind: "command"; readonly command: SlashCommandDefinition; readonly binding: SlashCommandBinding; readonly argumentsText: string };

/** Registers one canonical definition with its Desktop-only execution binding. */
export interface LocalSlashCommandRegistration {
	readonly definition: SlashCommandDefinition;
	readonly actionId: string;
}

interface CatalogEntry {
	readonly command: SlashCommandDefinition;
	readonly binding: SlashCommandBinding;
}

/** Owns the current validated Slash Commands snapshot shared by parsing and completion. */
export class SlashCommandCatalog {
	private readonly local: readonly LocalSlashCommandRegistration[];
	private server: readonly SlashCommandDefinition[] = Object.freeze([]);
	private entriesByName: ReadonlyMap<string, CatalogEntry> = new Map();
	private _commands: readonly SlashCommandDefinition[] = Object.freeze([]);

	constructor(local: readonly LocalSlashCommandRegistration[], server: readonly SlashCommandDefinition[]) {
		this.local = Object.freeze([...local]);
		this.setServerCommands(server);
	}

	get commands(): readonly SlashCommandDefinition[] {
		return this._commands;
	}

	setServerCommands(server: readonly SlashCommandDefinition[]): void {
		this.server = Object.freeze([...server]);
		this.rebuild();
	}

	private rebuild(): void {
		const entriesByName = new Map<string, CatalogEntry>();
		const commands: SlashCommandDefinition[] = [];
		const append = (command: SlashCommandDefinition, binding: SlashCommandBinding): void => {
			const normalized = validateDefinition(command);
			if (entriesByName.has(normalized.name)) throw new RangeError(`Duplicate Slash Command name: /${normalized.name}`);
			const entry = Object.freeze({ command: normalized, binding });
			entriesByName.set(normalized.name, entry);
			commands.push(normalized);
		};
		for (const local of this.local) {
			if (!local.actionId.trim()) throw new TypeError(`Local Slash Command /${local.definition.name} requires an action ID`);
			append(local.definition, Object.freeze({ origin: "local", actionId: local.actionId }));
		}
		for (const command of this.server) append(command, Object.freeze({ origin: "server" }));
		this.entriesByName = entriesByName;
		this._commands = Object.freeze(commands);
	}

	get(name: string): SlashCommandDefinition | undefined {
		return this.entriesByName.get(name)?.command;
	}

	binding(name: string): SlashCommandBinding | undefined {
		return this.entriesByName.get(name)?.binding;
	}

	matching(query: string): readonly SlashCommandDefinition[] {
		if (!query) return this.commands;
		const normalizedQuery = query.replace(/[A-Z]/g, character => character.toLowerCase());
		return this.commands
			.flatMap((command, index) => {
				const score = commandMatchScore(command.name, normalizedQuery) ?? descriptionMatchScore(command.description, normalizedQuery);
				return score ? [{ command, index, score }] : [];
			})
			.sort((left, right) => compareMatchScores(left.score, right.score) || left.index - right.index)
			.map(match => match.command);
	}
}

const enum MatchKind {
	Exact,
	Prefix,
	WordPrefix,
	Substring,
	Subsequence,
	DescriptionWordPrefix,
	DescriptionSubstring,
	DescriptionSubsequence,
}

type MatchScore = readonly [kind: MatchKind, gap: number, start: number];

function commandMatchScore(name: string, query: string): MatchScore | undefined {
	if (name === query) return [MatchKind.Exact, 0, 0];
	if (name.startsWith(query)) return [MatchKind.Prefix, 0, 0];
	if ([...query].length < 2) return undefined;
	const wordStart = name.indexOf(`-${query}`);
	if (wordStart >= 0) return [MatchKind.WordPrefix, 0, wordStart + 1];
	const substringStart = name.indexOf(query);
	if (substringStart >= 0) return [MatchKind.Substring, 0, substringStart];
	const characters = [...name];
	const needle = [...query];
	let best: MatchScore | undefined;
	for (let start = 0; start < characters.length; start++) {
		if (characters[start] !== needle[0]) continue;
		let matched = 1;
		for (let end = start + 1; end < characters.length; end++) {
			if (characters[end] !== needle[matched]) continue;
			matched++;
			if (matched === needle.length) {
				const score: MatchScore = [MatchKind.Subsequence, end - start + 1 - needle.length, start];
				if (!best || compareMatchScores(score, best) < 0) best = score;
				break;
			}
		}
	}
	return best;
}

function descriptionMatchScore(description: string, query: string): MatchScore | undefined {
	if ([...query].length < 2) return undefined;
	const normalized = description.replace(/[A-Z]/g, character => character.toLowerCase());
	for (const match of normalized.matchAll(new RegExp(escapeRegExp(query), 'g'))) {
		const start = match.index;
		if (start === 0 || !/[\p{L}\p{N}]/u.test([...normalized.slice(0, start)].at(-1)!)) return [MatchKind.DescriptionWordPrefix, 0, [...normalized.slice(0, start)].length];
	}
	const substringStart = normalized.indexOf(query);
	if (substringStart >= 0) return [MatchKind.DescriptionSubstring, 0, [...normalized.slice(0, substringStart)].length];
	const subsequence = commandMatchScore(normalized, query);
	return subsequence?.[0] === MatchKind.Subsequence
		? [MatchKind.DescriptionSubsequence, subsequence[1], subsequence[2]]
		: undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareMatchScores(left: MatchScore, right: MatchScore): number {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function matchedCharacterIndices(text: string, query: string): readonly number[] {
	if (!query) return [];
	const characters = [...text.replace(/[A-Z]/g, character => character.toLowerCase())];
	const needle = [...query.replace(/[A-Z]/g, character => character.toLowerCase())];
	if (needle.length > characters.length) return [];
	for (let start = 0; start <= characters.length - needle.length; start++) {
		if (needle.every((character, offset) => characters[start + offset] === character)) {
			return needle.map((_, offset) => start + offset);
		}
	}
	let best: { gap: number; start: number; indices: number[] } | undefined;
	for (let start = 0; start < characters.length; start++) {
		if (characters[start] !== needle[0]) continue;
		const indices = [start];
		for (let index = start + 1; index < characters.length && indices.length < needle.length; index++) {
			if (characters[index] !== needle[indices.length]) continue;
			indices.push(index);
			if (indices.length === needle.length) {
				const gap = index - start + 1 - needle.length;
				if (!best || gap < best.gap || (gap === best.gap && start < best.start)) best = { gap, start, indices };
			}
		}
	}
	return best?.indices ?? [];
}

const productActions: Record<keyof typeof ProductSlashCommands, string> = {
	marketplace: OPEN_MARKETPLACE_COMMAND_ID,
	plugins: OPEN_PLUGINS_COMMAND_ID,
	skills: OPEN_SKILLS_COMMAND_ID,
	lsp: OPEN_LANGUAGE_SERVERS_COMMAND_ID,
};

export const DesktopSlashCommands: readonly LocalSlashCommandRegistration[] = Object.freeze([
	localCommand("new", "Start a new chat", NEW_CHAT_COMMAND_ID),
	localCommand("history", "Show chat history", SHOW_CHAT_HISTORY_COMMAND_ID),
	localCommand("config", localize('chat.settings.openCommand', 'Open chat settings'), OPEN_CHAT_SETTINGS_COMMAND_ID),
	...Object.entries(productActions).map(([id, actionId]) => ({ definition: ProductSlashCommands[id as keyof typeof ProductSlashCommands], actionId })),
]);

export function parseSlashCommandInput(value: string, catalog: SlashCommandCatalog): SlashCommandInput {
	if (!value.startsWith("/")) return { kind: "message", text: value };
	const body = value.slice(1);
	const separator = body.search(/\s/);
	const name = separator === -1 ? body : body.slice(0, separator);
	const command = catalog.get(name);
	const binding = catalog.binding(name);
	if (!command || !binding) return { kind: "unknown", name };
	const argumentsText = separator === -1 ? "" : body.slice(separator).trimStart();
	if (argumentsText && command.argumentMode === "none") return { kind: "unknown", name };
	return { kind: "command", command, binding, argumentsText };
}

function localCommand(name: string, description: string, actionId: string): LocalSlashCommandRegistration {
	return Object.freeze({ definition: Object.freeze({ name, description, argumentMode: "none" }), actionId });
}

function validateDefinition(definition: SlashCommandDefinition): SlashCommandDefinition {
	if (!definition || typeof definition !== "object") throw new TypeError("Slash Command definition must be an object");
	validateName(definition.name);
	if (!definition.description.trim()) throw new TypeError(`Slash Command /${definition.name} requires a description`);
	if (definition.argumentMode !== "none" && definition.argumentMode !== "optional") throw new TypeError(`Slash Command /${definition.name} has an invalid argument mode`);
	return Object.freeze({
		name: definition.name,
		description: definition.description,
		argumentMode: definition.argumentMode,
		...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
	});
}

function validateName(name: string): string {
	if (!SLASH_COMMAND_NAME.test(name)) throw new TypeError(`Invalid Slash Command name: ${name}`);
	return name;
}
