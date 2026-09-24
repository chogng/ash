import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const editorRoot = resolve(desktopRoot, "src/ash/editor");
const workbenchRoot = resolve(desktopRoot, "src/ash/workbench");

test("editor exposes one flat VS Code-shaped domain for both feature implementations", () => {
	assert.deepEqual(directoryNames(editorRoot), ["browser", "common", "contrib", "standalone", "test"]);
	assert.deepEqual(directoryNames(join(editorRoot, "common")), ["commands", "config", "core", "cursor", "diff", "languages", "model", "services", "standalone", "tokens", "viewLayout", "viewModel"]);
	assert.deepEqual(directoryNames(join(editorRoot, "browser")), ["config", "controller", "gpu", "services", "view", "viewParts", "widget"]);
	assert.equal(statSafe(join(editorRoot, "contrib", "academic")), true);
	assert.equal(statSafe(join(editorRoot, "editor.academic.all.ts")), true);
	assert.deepEqual(collectFiles(editorRoot).filter(file => /[\\/]index\.ts$/u.test(file)), []);
});

test("document editing separates editor capabilities from Workbench hosting", () => {
	for (const file of [
		"common/core/documentSelection.ts",
		"common/model/textModel.ts",
		"common/model/pieceTreeTextBuffer/rbTreeBase.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeBase.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts",
		"common/model/lineDocument.ts",
		"common/model/textModelBlockState.ts",
		"common/model/lineDocumentProjection.ts",
		"common/services/resolverService.ts",
		"common/commands/documentCommands.ts",
		"browser/widget/richTextEditor/richTextEditorWidget.ts",
		"browser/widget/richTextEditor/richTextEditorWidget.css",
		"browser/widget/richTextEditor/htmlDocumentFragment.ts",
		"contrib/formatting/browser/formattingContribution.ts",
		"contrib/collaboration/common/controller.ts",
		"common/services/documentCollaborationService.ts",
		"contrib/academic/common/schema.ts",
	]) assert.equal(statSafe(join(editorRoot, file)), true, file);
	for (const file of [
		"contrib/documentEditor/browser/documentEditorInput.ts",
		"contrib/documentEditor/browser/documentEditorPane.ts",
		"contrib/documentEditor/browser/collaborationContribution.ts",
		"services/documentCollaboration/common/documentCollaborationService.ts",
		"contrib/documentEditor/browser/editorProfile.ts",
		"contrib/academic/browser/academicEditorProfile.ts",
		"contrib/academic/browser/academicEditor.contribution.ts",
		"services/documentEditor/browser/documentWorkingCopy.ts",
		"services/documentEditor/browser/documentEditorTextModelService.ts",
		"services/documentCollaboration/browser/appServerDocumentCollaborationService.ts",
		"services/documentCollaboration/browser/documentCollaborationService.ts",
		"services/documentCollaboration/browser/remoteDocumentCollaborationService.ts",
	]) assert.equal(statSafe(join(workbenchRoot, file)), true, file);
	for (const file of [
		"common/model/documentModel.ts",
		"common/services/documentModelService.ts",
		"common/services/structuredTextModelService.ts",
		"browser/widget/embeddedTextEditor.ts",
		"browser/widget/codeBlockEditorWidget.ts",
		"contrib/academic/browser/academicCodeBlockEditor.ts",
	]) assert.equal(statSafe(join(editorRoot, file)), false, file);
	for (const file of [
		"services/documentEditor/browser/browserDocumentModelService.ts",
		"services/documentEditor/browser/browserStructuredTextModelService.ts",
	]) assert.equal(statSafe(join(workbenchRoot, file)), false, file);
	assert.equal(statSafe(join(editorRoot, "contrib", "collaboration", "common", "session.ts")), false);
	for (const file of collectFiles(join(editorRoot, "common"))) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /from\s+["'][^"']*(?:workbench|electron)[^"']*["']/u, relative(editorRoot, file));
	}
	for (const file of collectFiles(editorRoot)) {
		const editorRelativePath = relative(editorRoot, file);
		if (!file.endsWith(".ts") || /(?:^|[\\/])test(?:[\\/]|$)/u.test(editorRelativePath)) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /app[ -]?server/iu, editorRelativePath);
	}
});

test("document editing keeps lines and orthogonal rich semantics in one TextModel", () => {
	const schema = readFileSync(join(editorRoot, "common/model/documentSchema.ts"), "utf8");
	const textModel = readFileSync(join(editorRoot, "common/model/textModel.ts"), "utf8");
	const textBuffer = readFileSync(join(editorRoot, "common/model.ts"), "utf8");
	const pieceTree = readFileSync(join(editorRoot, "common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts"), "utf8");
	const pieceTreeBuilder = readFileSync(join(editorRoot, "common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts"), "utf8");
	const redBlackTree = readFileSync(join(editorRoot, "common/model/pieceTreeTextBuffer/rbTreeBase.ts"), "utf8");
	const lineDocument = readFileSync(join(editorRoot, "common/model/lineDocument.ts"), "utf8");
	const lineProjection = readFileSync(join(editorRoot, "common/model/lineDocumentProjection.ts"), "utf8");
	const pane = readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorPane.ts"), "utf8");
	const editor = readFileSync(join(editorRoot, "browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8");
	const formatting = readFileSync(join(editorRoot, "contrib/formatting/browser/formattingContribution.ts"), "utf8");
	const academicContribution = readFileSync(join(workbenchRoot, "contrib/academic/browser/academicEditor.contribution.ts"), "utf8");
	const editorAll = readFileSync(join(editorRoot, "editor.academic.all.ts"), "utf8");
	assert.match(schema, /codeBlock:/u);
	assert.match(schema, /"root" \| "group" \| "block" \| "line" \| "inline" \| "text"/u);
	assert.match(pane, /export class DocumentEditorPane/u);
	assert.match(pane, /implements IEditorPane/u);
	assert.match(textModel, /static create\(/u);
	assert.match(textModel, /get lineDocument/u);
	assert.match(textModel, /getLineId/u);
	assert.match(textModel, /private buffer: ITextBuffer/u);
	assert.doesNotMatch(textModel, /TextModelStructure|structureIndex|TextModelBlockTree/u);
	assert.match(textBuffer, /export interface ITextBuffer/u);
	assert.doesNotMatch(textBuffer, /PieceTree/u);
	assert.match(pieceTreeBuilder, /new PieceTreeTextBufferBuilder/u);
	assert.match(pieceTreeBuilder, /return builder\.finish\(\)\.create\(defaultEOL\)\.textBuffer/u);
	assert.match(pieceTreeBuilder, /implements ITextBufferBuilder/u);
	assert.match(pieceTreeBuilder, /return new PieceTreeTextBuffer/u);
	assert.match(pieceTree, /from "\.\/rbTreeBase\.js"/u);
	assert.match(redBlackTree, /export const enum NodeColor/u);
	assert.match(redBlackTree, /function fixInsert/u);
	assert.match(redBlackTree, /function fixDelete/u);
	assert.match(lineDocument, /export interface LineDocumentSnapshot/u);
	assert.match(lineDocument, /export class LineSequence/u);
	assert.match(lineDocument, /export class RangeStore/u);
	assert.match(lineDocument, /export class PointStore/u);
	assert.match(lineDocument, /export class LineFacetStore/u);
	assert.match(lineDocument, /export class RegionStore/u);
	assert.match(lineDocument, /export class RelationStore/u);
	assert.match(lineProjection, /projectDocumentToLines/u);
	assert.match(lineProjection, /node\.type === 'codeBlock'/u);
	assert.match(pane, /DocumentEditorTextModelService/u);
	assert.match(editor, /export class RichTextEditorWidget/u);
	assert.doesNotMatch(editor, /ITextModelResourceService|TextModelWorkingCopyReference|requireWorkingCopy/u);
	assert.match(pane, /TextModelWorkingCopyReference/u);
	assert.match(editor, /setModel\(model: TextModel/u);
	assert.match(editor, /case "codeBlock":[\s\S]*this\.appendEditableText\(element, node, model, decorations\)/u);
	assert.doesNotMatch(editor, /new TextModel|TextModel\.createStructured|EmbeddedTextEditor|CodeBlockEditorWidget/u);
	assert.doesNotMatch(academicContribution, /AcademicCodeBlockEditorFactory|EmbeddedTextEditor|CodeEditorWidget/u);
	assert.match(formatting, /new ToolBar\(/u);
	const collaborationService = readFileSync(join(editorRoot, "common/services/documentCollaborationService.ts"), "utf8");
	const collaborationWidget = readFileSync(join(editorRoot, "browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8");
	const collaborationRouter = readFileSync(join(workbenchRoot, "services/documentCollaboration/browser/documentCollaborationService.ts"), "utf8");
	const documentPane = readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorPane.ts"), "utf8");
	assert.doesNotMatch(collaborationService, /IDocumentCollaborationService|createInvite|listMembers|accessToken|RoomRole/u);
	const roomService = readFileSync(join(workbenchRoot, "services/documentCollaboration/common/documentCollaborationService.ts"), "utf8");
	assert.match(roomService, /export interface IDocumentCollaborationService/u);
	assert.match(roomService, /createInvite|listMembers/u);
	assert.match(collaborationService, /export interface DocumentCollaborationEnvelope/u);
	assert.doesNotMatch(collaborationService, /from\s+["'][^"']*contrib\//u);
	assert.doesNotMatch(collaborationService, /from\s+["'][^"']*(?:platform|workbench|electron|generated)[^"']*["']/u);
	assert.doesNotMatch(collaborationService, /DocumentCollaborationTarget|endpoint|bearerToken/u);
	assert.match(documentPane, /new CollaborationContribution/u);
	assert.doesNotMatch(collaborationWidget, /createInvite|listMembers|accessToken|RoomRole/u);
	assert.doesNotMatch(collaborationWidget, /AppServerDocumentCollaborationService|endpoint|bearerToken/u);
	assert.match(collaborationRouter, /ownerWindow\.prompt/u);
	assert.match(collaborationRouter, /RemoteDocumentCollaborationService/u);
	assert.match(documentPane, /createDocumentCollaborationService\(ownerWindow\)/u);
	assert.doesNotMatch(editor, /Session/u);
	assert.doesNotMatch(editorAll, /academicEditor\.contribution|workbench/u);
});

function directoryNames(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
}

function collectFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...collectFiles(file));
		else result.push(file);
	}
	return result;
}

function statSafe(file: string): boolean {
	try {
		return statSync(file).isDirectory() || statSync(file).isFile();
	} catch {
		return false;
	}
}
