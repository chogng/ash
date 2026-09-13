import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "mocha";

import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type LanguageWorkspaceSymbol } from "../../../../../editor/common/languages/workspaceSymbols.js";
import { type IFileService } from "../../../../../platform/files/common/files.js";
import { type IEditorService } from "../../../../services/editor/common/editorService.js";
import { type IWorkingCopyService } from "../../../../services/workingCopy/common/workingCopyService.js";
import { acceptWorkspaceSymbol } from "../../browser/workspaceSymbolNavigation.js";
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';

const resource = URI.file("/workspace/src/main.rs");
const range = Range.fromPositions(new Position((2) + 1, (4) + 1), new Position((2) + 1, (8) + 1));

test("workspace symbol acceptance refreshes instead of opening a stale local result", async () => {
	const events = acceptanceEvents("current");

	await acceptWorkspaceSymbol(symbol("sha256:stale"), events.files, events.workingCopies, events.editor, events.quickPick, events.refresh);

	assert.equal(events.refreshed(), 1);
	assert.equal(events.hidden(), 0);
	assert.equal(events.opened(), 0);
});

test("workspace symbol acceptance opens a revision-verified local result", async () => {
	const events = acceptanceEvents("current");

	await acceptWorkspaceSymbol(symbol("sha256:current"), events.files, events.workingCopies, events.editor, events.quickPick, events.refresh);

	assert.equal(events.refreshed(), 0);
	assert.equal(events.hidden(), 1);
	assert.equal(events.opened(), 1);
});

test("workspace symbol acceptance verifies an unsaved local result against current editor content", async () => {
	const content = "fn ephemeral_workspace_symbol() {}\n";
	const events = acceptanceEvents("persisted", content);

	await acceptWorkspaceSymbol(symbol(sha256Revision(content)), events.files, events.workingCopies, events.editor, events.quickPick, events.refresh);

	assert.equal(events.refreshed(), 0);
	assert.equal(events.hidden(), 1);
	assert.equal(events.opened(), 1);
});

function symbol(sourceRevision: string): LanguageWorkspaceSymbol {
	return { name: "main", kind: "function", resource, range, data: { source: "codebaseSymbols", sourceRevision } };
}

function acceptanceEvents(revision: string, workingCopyContent?: string) {
	let hidden = 0;
	let refreshed = 0;
	let opened = 0;
	const files = { readFile: async () => ({ resource, content: "fn main() {}\n", revision }) } as unknown as IFileService;
	const workingCopies = { get: () => workingCopyContent === undefined ? [] : [{ backupKind: "text", backup: () => workingCopyContent }] } as unknown as IWorkingCopyService;
	const editor = { ...emptyEditorServiceState, openEditor: async () => { opened += 1; }, focusActiveEditor() {} } satisfies IEditorService;
	return {
		files,
		workingCopies,
		editor,
		quickPick: { hide: () => { hidden += 1; } },
		refresh: () => { refreshed += 1; },
		hidden: () => hidden,
		refreshed: () => refreshed,
		opened: () => opened,
	};
}

function sha256Revision(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
