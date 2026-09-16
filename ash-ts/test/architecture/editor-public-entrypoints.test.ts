import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const editorRoot = resolve(findDesktopRoot(import.meta.dirname), "src/ash/editor");

test("flat Stanza domain exposes public entrypoints and mode bundles", () => {
	for (const entrypoint of ["editor.api.ts", "editor.code.all.ts", "editor.academic.all.ts", "editor.all.ts", "editor.main.ts", "editor.worker.start.ts"]) {
		assert.equal(exists(join(editorRoot, entrypoint)), true, entrypoint);
	}
	for (const retiredEntrypoint of ["stanza.api.ts", "stanza.code.all.ts", "stanza.academic.all.ts", "stanza.all.ts", "stanza.main.ts", "stanza.worker.start.ts"]) {
		assert.equal(exists(join(editorRoot, retiredEntrypoint)), false, retiredEntrypoint);
	}
	for (const standaloneOwner of ["standalone/browser/standaloneServices.ts", "standalone/browser/standaloneEditor.ts", "standalone/browser/standaloneCodeEditor.ts", "standalone/browser/standaloneLanguages.ts"]) {
		assert.equal(exists(join(editorRoot, standaloneOwner)), true, standaloneOwner);
	}
	for (const modelOwner of ["common/services/model.ts", "common/services/modelService.ts"]) assert.equal(exists(join(editorRoot, modelOwner)), true, modelOwner);
});

test("public Stanza entrypoints retain distinct API, contribution, main, and worker roles", () => {
	const api = readFileSync(join(editorRoot, "editor.api.ts"), "utf8");
	const codeBundle = readFileSync(join(editorRoot, "editor.code.all.ts"), "utf8");
	const academicBundle = readFileSync(join(editorRoot, "editor.academic.all.ts"), "utf8");
	const all = readFileSync(join(editorRoot, "editor.all.ts"), "utf8");
	const main = readFileSync(join(editorRoot, "editor.main.ts"), "utf8");
	const worker = readFileSync(join(editorRoot, "editor.worker.start.ts"), "utf8");
	const baseApi = readFileSync(join(editorRoot, "common/services/editorBaseApi.ts"), "utf8");
	const editorWorkerService = readFileSync(join(editorRoot, "browser/services/editorWorkerService.ts"), "utf8");
	const editorWorker = readFileSync(join(editorRoot, "common/services/editorWebWorkerMain.ts"), "utf8");
	const standaloneEditor = readFileSync(join(editorRoot, "standalone/browser/standaloneEditor.ts"), "utf8");
	const standaloneCodeEditor = readFileSync(join(editorRoot, "standalone/browser/standaloneCodeEditor.ts"), "utf8");
	const standaloneLanguages = readFileSync(join(editorRoot, "standalone/browser/standaloneLanguages.ts"), "utf8");
	const standaloneServices = readFileSync(join(editorRoot, "standalone/browser/standaloneServices.ts"), "utf8");
	const models = readFileSync(join(editorRoot, "common/services/modelService.ts"), "utf8");
	assert.match(api, /TextModel/u);
	assert.match(api, /createStandaloneEditorApi/u);
	assert.match(api, /createEditorBaseApi/u);
	assert.match(api, /createStandaloneLanguagesApi/u);
	assert.match(api, /export const editor/u);
	assert.match(api, /export const languages/u);
	assert.match(api, /export \{ PositionAffinity \} from '\.\/common\/model\.js'/u);
	assert.match(api, /LineDocumentSnapshot/u);
	assert.match(api, /LineSequence/u);
	assert.match(api, /RangeStore/u);
	assert.match(api, /PointStore/u);
	assert.doesNotMatch(api, /TextModelStructure/u);
	assert.doesNotMatch(api, /TextModelBlockTree|TextModelGroup/u);
	assert.doesNotMatch(api, /\bDocumentModel\b/u);
	assert.doesNotMatch(api, /workbench/u);
	assert.doesNotMatch(api, /^import\s+(?!type\b).*contrib/mu);
	assert.match(standaloneEditor, /export function create\(/u);
	assert.match(standaloneEditor, /createModel/u);
	assert.match(standaloneEditor, /PositionAffinity,/u);
	assert.match(standaloneCodeEditor, /class StandaloneEditor/u);
	assert.match(standaloneLanguages, /export function register\(/u);
	assert.match(standaloneLanguages, /export function registerLanguages\(/u);
	assert.match(standaloneLanguages, /export function registerProviderBatch\(/u);
	assert.match(standaloneLanguages, /export function setLanguageConfiguration\(/u);
	assert.match(standaloneLanguages, /registerHoverProvider/u);
	assert.match(baseApi, /export function createEditorBaseApi/u);
	assert.match(standaloneServices, /StandaloneServices/u);
	assert.match(models, /onModelAdded/u);
	for (const commonOrStandaloneOwner of [standaloneEditor, standaloneCodeEditor, standaloneLanguages, standaloneServices, models]) assert.doesNotMatch(commonOrStandaloneOwner, /workbench/u);
	assert.match(codeBundle, /editor\.all/u);
	assert.doesNotMatch(codeBundle, /contrib\//u);
	assert.doesNotMatch(codeBundle, /contrib\/academic/u);
	assert.doesNotMatch(academicBundle, /editor\.all/u);
	assert.match(academicBundle, /contrib\/documentEditor\.contribution/u);
	assert.doesNotMatch(academicBundle, /workbench|academicEditor\.contribution/u);
	assert.match(all, /browser\/coreCommands/u);
	assert.match(all, /quickAccess\/browser\/quickAccessController/u);
	assert.doesNotMatch(all, /editor\.(?:code|academic)\.all/u);
	assert.match(main, /import "\.\/editor\.all\.js"/u);
	assert.match(main, /export \* from "\.\/editor\.api\.js"/u);
	assert.match(worker, /StanzaWorkerPort/u);
	assert.match(worker, /export function start/u);
	assert.match(editorWorkerService, /class VersionedEditorWorkerClient/u);
	assert.match(editorWorker, /editor\.worker\.start/u);
	for (const retired of ["syntaxWorkerMain.ts", "languageCompletionWorkerMain.ts"]) assert.equal(exists(join(editorRoot, "browser/services", retired)), false);
	const retiredBrowserLanguageDirectory = join(editorRoot, "browser/language");
	assert.deepEqual(existsSync(retiredBrowserLanguageDirectory) ? readdirSync(retiredBrowserLanguageDirectory) : [], []);
});

function exists(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}
