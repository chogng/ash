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
	readonly aliases?: readonly string[];
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
		const append = (command: SlashCommandDefinition, binding: SlashCommandBinding, aliases: readonly string[] = []): void => {
			const normalized = validateDefinition(command);
			const names = [normalized.name, ...aliases.map(validateName)];
			if (new Set(names).size !== names.length) throw new RangeError(`Duplicate Slash Command name: /${normalized.name}`);
			for (const name of names) {
				if (entriesByName.has(name)) throw new RangeError(`Duplicate Slash Command name: /${name}`);
			}
			const entry = Object.freeze({ command: normalized, binding });
			for (const name of names) entriesByName.set(name, entry);
			commands.push(normalized);
		};
		for (const local of this.local) {
			if (!local.actionId.trim()) throw new TypeError(`Local Slash Command /${local.definition.name} requires an action ID`);
			append(local.definition, Object.freeze({ origin: "local", actionId: local.actionId }), local.aliases);
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

	matching(prefix: string): readonly SlashCommandDefinition[] {
		return this.commands.filter(command => command.name.startsWith(prefix) || [...this.entriesByName].some(([name, entry]) => entry.command === command && name.startsWith(prefix)));
	}
}

const productActions: Record<keyof typeof ProductSlashCommands, string> = {
	marketplace: OPEN_MARKETPLACE_COMMAND_ID,
	plugins: OPEN_PLUGINS_COMMAND_ID,
	skills: OPEN_SKILLS_COMMAND_ID,
	lsp: OPEN_LANGUAGE_SERVERS_COMMAND_ID,
};

export const DesktopSlashCommands: readonly LocalSlashCommandRegistration[] = Object.freeze([
	localCommand("new", "Start a new chat", NEW_CHAT_COMMAND_ID),
	localCommand("history", "Show chat history", SHOW_CHAT_HISTORY_COMMAND_ID, ["chats"]),
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

function localCommand(name: string, description: string, actionId: string, aliases?: readonly string[]): LocalSlashCommandRegistration {
	return Object.freeze({ definition: Object.freeze({ name, description, argumentMode: "none" }), actionId, ...(aliases ? { aliases: Object.freeze([...aliases]) } : {}) });
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
