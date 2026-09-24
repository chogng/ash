import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { EditorPaneMatch } from "../../../../browser/parts/editor/editorPane.js";
import { academicProfile } from "../../browser/academicEditorProfile.js";
import { matchDocumentEditor } from "../../../documentEditor/browser/documentEditorInput.js";
import { createDocumentEditorPaneOptions, findEditorProfile, matchEditorProfiles } from "../../../documentEditor/browser/editorProfile.js";

test("Stanza input matching is supplied by the active Workbench profile", () => {
	const matcher = { contentTypes: ["application/vnd.ash.document+json"], extensions: [".ash-doc"] };
	assert.equal(matchDocumentEditor({ resource: URI.file("C:\\project\\paper.ASH-DOC") }, matcher), EditorPaneMatch.Default);
	assert.equal(matchDocumentEditor({ resource: URI.file("C:\\project\\paper.bin"), contentType: "application/vnd.ash.document+json" }, matcher), EditorPaneMatch.Default);
	assert.equal(matchDocumentEditor({ resource: URI.file("C:\\project\\paper.bin"), contentType: "text/plain" }, matcher), EditorPaneMatch.None);
	assert.equal(matchEditorProfiles({ resource: URI.file("C:\\project\\paper.ash-academic") }, [academicProfile]), EditorPaneMatch.Default);
	assert.equal(findEditorProfile({ resource: URI.file("C:\\project\\paper.txt") }, [academicProfile]), undefined);
});

test("Stanza profile materialization keeps schema and browser extensions together", () => {
	const options = createDocumentEditorPaneOptions(academicProfile);
	assert.equal(options.schema?.getNodeSpec("citation")?.kind, "inline");
	assert.equal(options.schema?.getNodeSpec("title")?.kind, "group");
	assert.equal(options.schema?.getNodeSpec("section")?.kind, "group");
	assert.equal(options.schema?.getNodeSpec("bibliography")?.kind, "group");
	assert.equal(options.outlineNavigator, true);
	assert.equal(options.plugins?.length, 1);
	assert.ok(options.nodeViews?.bibliography);
	assert.ok(options.inlineNodeViews?.citation);
	assert.deepEqual(options.createEmptyDocument?.().content.map(node => node.type), ["title", "abstract"]);
});
