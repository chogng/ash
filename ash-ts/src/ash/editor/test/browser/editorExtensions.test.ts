import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { EditorExtensionsRegistry, registerTextEditorCapabilityContribution } from "../../browser/editorExtensions.js";
import { getTextEditorCapabilityContributions } from "../../browser/editorExtensions.js";
import { TriggerInlineEditCommandsRegistry } from '../../browser/triggerInlineEditCommandsRegistry.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
Object.defineProperty(globalThis, "window", { configurable: true, value: browserEnvironment.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: browserEnvironment.window.document });

suiteTeardown(() => browserEnvironment.window.close());

test("editor contributions retain bundle registration order and stable identity", async () => {
	const before = getTextEditorCapabilityContributions().map(contribution => contribution.id);
	assert.equal(before.includes("editor.contrib.findController"), false);

	await import("../../contrib/find/browser/find.contribution.js");
	const after = getTextEditorCapabilityContributions().map(contribution => contribution.id);
	assert.deepEqual(after, [...before, "editor.contrib.findController"]);
	const contribution = getTextEditorCapabilityContributions().find(candidate => candidate.id === "editor.contrib.findController");
	assert.ok(contribution);
	assert.doesNotThrow(() => contribution.install?.({ kind: "document" } as never));

	assert.throws(() => registerTextEditorCapabilityContribution({ id: "editor.contrib.findController", install() {} }), /Duplicate editor contribution/);
	assert.deepEqual(getTextEditorCapabilityContributions().map(contribution => contribution.id), after);
});

test("Code bundle explicitly registers independently selectable editor capabilities", async () => {
	await import("../../editor.code.all.js");
	const ids = new Set(getTextEditorCapabilityContributions().map(contribution => contribution.id));
	for (const id of [
		"editor.contrib.bracketMatching",
		"editor.contrib.codeAction",
		"editor.contrib.comment",
		"editor.contrib.folding",
		"editor.contrib.format",
		"editor.contrib.gotoSymbol",
		"editor.contrib.hover",
		"editor.contrib.multicursor",
		"editor.contrib.selectionHighlighter",
		"editor.contrib.rename",
		"editor.contrib.wordHighlighter",
	]) {
		assert.equal(ids.has(id), true, id);
	}
	const contributionIds = new Set(EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id));
	for (const id of [
		'editor.contrib.clipboard',
		'editor.contrib.cursorUndoRedoController',
		'editor.contrib.dropIntoEditorController',
		'editor.contrib.messageController',
		'editor.contrib.placeholderText',
		'editor.contrib.readOnlyMessageController',
	]) assert.equal(contributionIds.has(id), true, id);
	assert.equal(contributionIds.has('editor.contrib.linesOperations'), false);
	assert.equal(contributionIds.has('editor.contrib.transposeLetters'), false);
	const actionIds = new Set([...EditorExtensionsRegistry.getEditorActions()].map(action => action.id));
	assert.equal(actionIds.has('editor.action.commentLine'), true);
	assert.equal(actionIds.has('editor.action.blockComment'), true);
	assert.equal(ids.has("editor.contrib.documentFormatting"), false);
	const triggerCommands = new Set(TriggerInlineEditCommandsRegistry.getRegisteredCommands());
	for (const id of [
		'editor.action.removeBrackets',
		'editor.action.commentLine',
		'editor.action.blockComment',
		'editor.action.joinLines',
		'editor.action.rename',
		'editor.action.transpose',
		'editor.action.transposeLetters',
	]) assert.equal(triggerCommands.has(id), true, id);
});

test('Inline edit trigger command metadata validates IDs and deduplicates registrations', () => {
	const id = 'editor.test.triggerInlineEdit';
	TriggerInlineEditCommandsRegistry.registerCommand(id);
	TriggerInlineEditCommandsRegistry.registerCommand(id);
	assert.equal(TriggerInlineEditCommandsRegistry.getRegisteredCommands().filter(candidate => candidate === id).length, 1);
	assert.throws(() => TriggerInlineEditCommandsRegistry.registerCommand(''), /non-empty string/);
});
