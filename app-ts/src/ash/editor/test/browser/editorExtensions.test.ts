import assert from "node:assert/strict";
import { test } from "mocha";
import { Disposable } from '../../../base/common/lifecycle.js';
import { EditorContributionInstantiation, EditorExtensionsRegistry, registerEditorContribution } from "../../browser/editorExtensions.js";
import { TriggerInlineEditCommandsRegistry } from '../../browser/triggerInlineEditCommandsRegistry.js';

await import('./testEditorDom.js');

test("editor contributions retain bundle registration order and stable identity", async () => {
	const before = EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id);
	assert.equal(before.includes("editor.contrib.findController"), false);

	await import("../../contrib/find/browser/findController.js");
	const after = EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id);
	assert.deepEqual(after, [...before, "editor.contrib.findController"]);
	const contribution = EditorExtensionsRegistry.getEditorContributions().find(candidate => candidate.id === "editor.contrib.findController");
	assert.ok(contribution && !('ctor' in contribution));
	assert.doesNotThrow(() => contribution.install?.({ kind: "document" } as never));

	assert.throws(() => registerEditorContribution({ id: "editor.contrib.findController", install() {} }), /Duplicate editor contribution/);
	assert.deepEqual(EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id), after);
});

test('Constructor and hook contributions reject duplicate IDs in either registration order', () => {
	class Contribution extends Disposable {}
	registerEditorContribution('test.registry.constructor', Contribution, EditorContributionInstantiation.Lazy);
	assert.throws(() => registerEditorContribution({ id: 'test.registry.constructor', install() {} }), /Duplicate editor contribution/);
	registerEditorContribution({ id: 'test.registry.hook', install() {} });
	assert.throws(() => registerEditorContribution('test.registry.hook', Contribution, EditorContributionInstantiation.Eager), /Duplicate editor contribution/);
	const snapshot = EditorExtensionsRegistry.getEditorContributions();
	snapshot.length = 0;
	assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['test.registry.constructor', 'test.registry.hook']).length, 2);
});

test("Code bundle explicitly registers independently selectable editor capabilities", async () => {
	await import("../../editor.code.all.js");
	const ids = new Set(EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id));
	for (const id of [
		"editor.contrib.bracketMatchingController",
		"editor.contrib.codeActionController",
		"editor.contrib.comment",
		"editor.contrib.folding",
		"editor.contrib.format",
		"editor.contrib.languageNavigation",
		"editor.contrib.hover",
		"editor.contrib.multicursor",
		"editor.contrib.selectionHighlighter",
		"editor.contrib.renameController",
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
