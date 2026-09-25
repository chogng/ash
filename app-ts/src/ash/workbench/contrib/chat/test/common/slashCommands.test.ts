import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "mocha";
import { ProductSlashCommands, type SlashCommandDefinition } from "../../../../services/chat/common/chatService.js";
import { DesktopSlashCommands, matchedCharacterIndices, parseSlashCommandInput, SlashCommandCatalog } from "../../common/slashCommands.js";

const local = [{
	definition: { name: "history", description: "Show chat history", argumentMode: "none" as const },
	actionId: "chat.history",
}];

test("Product Slash Commands preserve shared definitions and local panel arguments", () => {
	const catalog = new SlashCommandCatalog(DesktopSlashCommands, []);
	assert.equal(catalog.get("chats"), undefined);
	for (const definition of Object.values(ProductSlashCommands)) {
		assert.deepEqual(catalog.get(definition.name), definition);
		assert.equal(catalog.binding(definition.name)?.origin, "local");
		assert.equal(parseSlashCommandInput(`/${definition.name}`, catalog).kind, "command");
		const parsed = parseSlashCommandInput(`/${definition.name} rust tools`, catalog);
		if (definition.argumentMode === "none") {
			assert.equal(parsed.kind, "unknown");
		} else {
			assert.equal(parsed.kind, "command");
			if (parsed.kind === "command") { assert.equal(parsed.argumentsText, "rust tools"); }
		}
	}
});

test("Slash Command input switches only for a leading slash", () => {
	const catalog = new SlashCommandCatalog(local, []);
	assert.deepEqual(parseSlashCommandInput("explain /history", catalog), { kind: "message", text: "explain /history" });
	assert.deepEqual(parseSlashCommandInput(" /history", catalog), { kind: "message", text: " /history" });
	assert.deepEqual(parseSlashCommandInput("/", catalog), { kind: "unknown", name: "" });
	assert.equal(parseSlashCommandInput("/HISTORY", catalog).kind, "unknown");
	assert.deepEqual(parseSlashCommandInput("/history project", catalog), { kind: "unknown", name: "history" });
});

test("Slash Command catalog composes local and server definitions", () => {
	const catalog = new SlashCommandCatalog(local, [{ name: "diagnose", description: "Inspect workspace", argumentMode: "optional" }]);
	assert.equal(catalog.binding("history")?.origin, "local");
	assert.equal(catalog.binding("chats"), undefined);
	assert.equal(parseSlashCommandInput("/chats", catalog).kind, "unknown");
	assert.equal(catalog.binding("diagnose")?.origin, "server");
	assert.deepEqual(catalog.matching("d").map(command => command.name), ["diagnose"]);
	assert.deepEqual(catalog.matching("hstry").map(command => command.name), ["history"]);
	assert.deepEqual(catalog.matching("chat").map(command => command.name), ["history"]);
	assert.equal(parseSlashCommandInput("/diagnose now", catalog).kind, "command");
	assert.equal(parseSlashCommandInput("/hstry", catalog).kind, "unknown");
	assert.deepEqual(matchedCharacterIndices('history', 'hstry'), [0, 2, 3, 5, 6]);
	const localized = new SlashCommandCatalog([], [{ name: 'config', description: '检查设置', argumentMode: 'none' }]);
	assert.deepEqual(localized.matching('设'), []);
	assert.deepEqual(localized.matching('设置').map(command => command.name), ['config']);
});

test("Slash Command catalog rejects invalid and colliding definitions", () => {
	assert.throws(() => new SlashCommandCatalog(local, [{ name: "history", description: "Collision", argumentMode: "none" }]), /Duplicate/);
	assert.throws(() => new SlashCommandCatalog([], [{ name: "Invalid", description: "Bad name", argumentMode: "none" }]), /Invalid/);
	assert.throws(() => new SlashCommandCatalog([], [{ name: "valid", description: " ", argumentMode: "none" }]), /description/);
});

test("Desktop adapter matches the shared Slash Commands conformance fixture", () => {
	const fixture = JSON.parse(readFileSync(join(process.cwd(), "..", "ash-rs", "slash-commands", "fixtures", "conformance.json"), "utf8")) as {
		definitions: SlashCommandDefinition[];
		matching: { query: string; names: string[] }[];
		inputs: { text: string; kind: string; name?: string; arguments?: string }[];
		invalidDefinitions: SlashCommandDefinition[];
	};
	const catalog = new SlashCommandCatalog([], fixture.definitions);
	for (const matching of fixture.matching) {
		assert.deepEqual(catalog.matching(matching.query).map(command => command.name), matching.names);
	}
	for (const input of fixture.inputs) {
		const parsed = parseSlashCommandInput(input.text, catalog);
		assert.equal(parsed.kind, input.kind);
		if (parsed.kind === "command") {
			assert.equal(parsed.command.name, input.name);
			assert.equal(parsed.argumentsText, input.arguments);
		}
	}
	for (const definition of fixture.invalidDefinitions) {
		assert.throws(() => new SlashCommandCatalog([], [definition]));
	}
});
