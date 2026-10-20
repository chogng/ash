import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const editorRoot = resolve(desktopRoot, "src/ash/editor");
const workbenchRoot = resolve(desktopRoot, "src/ash/workbench");
const workbenchImportPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*\/workbench\/[^"']*["']/u;

test("Editor keeps explicit feature files without index barrels", () => {
	const indexFiles = collectFiles(editorRoot).filter(file => file.endsWith("\\index.ts") || file.endsWith("/index.ts"));
	assert.deepEqual(indexFiles, []);
});

test("Editor production code does not depend on Workbench or generated transport DTOs", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") || isTestFile(file)) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, workbenchImportPattern, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*app-server\/common\/generated[^"']*["']/u, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*platform\/(?:syntax|diff)\/[^"']*["']/u, relative(editorRoot, file));
	}
});

test('Common editor contracts do not import contribution-owned modules', () => {
	for (const file of collectFiles(join(editorRoot, 'common'))) {
		if (!file.endsWith('.ts')) continue;
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu)) {
			const specifier = match[1]!;
			if (!specifier.startsWith('.')) continue;
			const target = relative(editorRoot, resolve(dirname(file), specifier)).replaceAll('\\', '/');
			assert.equal(target.startsWith('contrib/'), false, `${relative(editorRoot, file)} imports ${specifier}`);
		}
	}
});

test('Editor dependency checks distinguish layer paths from Platform filenames', () => {
	assert.doesNotMatch("import { editorBackground } from '../../platform/theme/common/colors/editorColors.js';", workbenchImportPattern);
	assert.match("import { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';", workbenchImportPattern);
	assert.match("import '../../workbench/browser/workbench.contribution.js';", workbenchImportPattern);
	assert.match("await import('../../workbench/browser/workbench.js');", workbenchImportPattern);
});

test("Bracket structure, cursor editing, and browser presentation keep separate owners", () => {
	for (const file of [
		"common/model/bracketPairsTextModelPart/bracketPairsImpl.ts",
		"common/cursor/cursor.ts",
		"common/cursor/cursorTypeOperations.ts",
		"common/cursor/cursorTypeEditOperations.ts",
		"browser/view/viewController.ts",
	]) assert.equal(existsSync(editorSource(file)), true, file);
	for (const file of [
		"contrib/bracketMatching/common/bracketMatching.ts",
		"contrib/bracketMatching/common/bracketColorization.ts",
		"contrib/bracketMatching/common/autoClosingTracker.ts",
		"contrib/bracketMatching/common/pairEditing.ts",
		"contrib/bracketMatching/common/enter.ts",
		"contrib/bracketMatching/browser/languageEditingAdapter.ts",
	]) assert.equal(existsSync(join(editorRoot, file)), false, file);
	const contribution = readFileSync(editorSource("contrib/bracketMatching/browser/bracketMatching.contribution.ts"), "utf8");
	assert.match(contribution, /context.model.bracketPairs/u);
	assert.doesNotMatch(contribution, /LanguageLexicalContextIndex|TokenAwareLanguageLexicalContext|LanguageEditingAdapter|LanguageAutoClosingTracker/u);
	const adapter = readFileSync(editorSource("browser/view/viewController.ts"), "utf8");
	assert.match(adapter, /common\/cursor\/cursorTypeOperations/u);
	assert.doesNotMatch(adapter, /\/contrib\//u);
});

test("Editor synchronous layers do not import Electron or generated DTOs", () => {
	const protectedDirectories = [
		"common/config",
		"common/core",
		"common/diff",
		"common/model",
		"common/cursor",
		"common/commands",
		"common/viewLayout",
		"common/viewModel",
	];
	for (const directory of protectedDirectories) {
		for (const file of collectFiles(join(editorRoot, directory))) {
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(file, "utf8");
			assert.doesNotMatch(source, /from\s+["'][^"']*(?:electron|generated)[^"']*["']/u, relative(editorRoot, file));
		}
	}
});

test('Required editor view parts are connected to their production owners', () => {
	const editorBrowser = readFileSync(join(editorRoot, 'browser/editorBrowser.ts'), 'utf8');
	const codeEditorWidget = readFileSync(join(editorRoot, 'browser/widget/codeEditor/codeEditorWidget.ts'), 'utf8');
	const view = readFileSync(join(editorRoot, 'browser/view.ts'), 'utf8');
	const viewOverlays = readFileSync(join(editorRoot, 'browser/view/viewOverlays.ts'), 'utf8');
	const whitespace = readFileSync(join(editorRoot, 'browser/viewParts/whitespace/whitespace.ts'), 'utf8');
	const overviewRuler = readFileSync(join(editorRoot, 'browser/viewParts/overviewRuler/overviewRuler.ts'), 'utf8');
	const textureAtlas = readFileSync(join(editorRoot, 'browser/gpu/atlas/textureAtlas.ts'), 'utf8');
	const placeholder = readFileSync(editorSource('contrib/placeholderText/browser/placeholderTextContribution.ts'), 'utf8');
	const textModel = readFileSync(join(editorRoot, 'common/model/textModel.ts'), 'utf8');
	const textModelSearch = readFileSync(join(editorRoot, 'common/model/textModelSearch.ts'), 'utf8');

	assert.match(editorBrowser, /interface IOverlayWidget[\s\S]*getId\(\)[\s\S]*getDomNode\(\)[\s\S]*getPosition\(\)/u);
	assert.match(editorBrowser, /interface IViewZoneChangeAccessor[\s\S]*addZone[\s\S]*removeZone[\s\S]*layoutZone/u);
	for (const operation of ['addOverlayWidget', 'layoutOverlayWidget', 'removeOverlayWidget']) {
		assert.match(codeEditorWidget, new RegExp(`view(?:\\?\\.)?\\.?${operation}\\(`, 'u'));
	}
	assert.match(codeEditorWidget, /view\.changeViewZones/u);
	assert.match(view, /new ViewOverlayWidgets/u);
	assert.match(view, /new RulersGpu/u);
	assert.match(view, /new ViewGpuContext/u);
	assert.match(view, /new ContentViewOverlays/u);
	assert.match(view, /new MarginViewOverlays/u);
	assert.match(viewOverlays, /addDynamicOverlay/u);
	assert.match(whitespace, /viewModel\.getCursorStates\(/u);
	assert.match(overviewRuler, /new OverviewZoneManager/u);
	assert.match(textureAtlas, /from ['"]\.\.\/taskQueue\.js['"]/u);
	assert.match(placeholder, /observableCodeEditor\(editor\)/u);
	assert.match(textModel, /countEOL\(edit\.text\)/u);
	assert.match(textModelSearch, /getMapForWordSeparators/u);
});

test('Editor implementation files have an importer or an explicit entrypoint', () => {
	const sourceRoot = resolve(desktopRoot, 'src');
	const sourceFiles = [...collectFiles(sourceRoot), ...collectFiles(resolve(desktopRoot, 'extensions'))].filter(file => file.endsWith('.ts'));
	const editorProductionFiles = sourceFiles.filter(file => file.startsWith(editorRoot) && !isTestFile(file));
	const incoming = new Map(editorProductionFiles.map(file => [architecturePathKey(file), 0]));
	const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

	for (const sourceFile of sourceFiles) {
		const source = readFileSync(sourceFile, 'utf8');
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (!specifier.startsWith('.')) continue;
			const target = architecturePathKey(resolve(dirname(sourceFile), specifier.replace(/\.js$/u, '.ts')));
			if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
		}
	}

	const explicitEntrypoints = new Set([
		resolve(editorRoot, 'editor.main.ts'),
		resolve(editorRoot, 'common/services/editorWebWorkerMain.ts'),
		resolve(editorRoot, 'common/diff/diffWorkerMain.ts'),
	].map(architecturePathKey));
	const unreferenced = editorProductionFiles.filter(file => {
		const key = architecturePathKey(file);
		return incoming.get(key) === 0 && !explicitEntrypoints.has(key);
	}).map(file => relative(editorRoot, file));
	assert.deepEqual(unreferenced, [], 'Editor files without an importer');
});

function architecturePathKey(path: string): string {
	return process.platform === 'win32' ? path.toLowerCase() : path;
}

test("Editor contracts and Widget composition stay separate from Workbench panes", () => {
	const editorBrowser = readFileSync(editorSource("browser/editorBrowser.ts"), "utf8");
	const codeEditorWidget = readFileSync(editorSource("browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	assert.equal(statSafe(join(editorRoot, "browser/editorPart.ts")), false, "editor-layer EditorPart");
	assert.equal(statSafe(join(workbenchRoot, "browser/parts/editor/editorPart.ts")), true, "Workbench EditorPart");
	assert.match(editorBrowser, /export interface IContentWidget/u);
	assert.match(editorBrowser, /export interface IOverlayWidget/u);
	assert.doesNotMatch(editorBrowser, /export class ConfiguredCodeEditor/u);
	assert.match(codeEditorWidget, /export class CodeEditorWidget/u);
	assert.equal(statSafe(join(editorRoot, "browser/configuredCodeEditor.ts")), false);
	assert.doesNotMatch(editorBrowser, /export class EditorPart/u);
});

test("ViewLine owns text rows while overlays own their row DOM", () => {
	const viewLine = readFileSync(editorSource("browser/viewParts/viewLines/viewLine.ts"), "utf8");
	for (const foreignRow of ["line-number", "diagnostic-marker", "indent-guides", "decorations", "selections", "cursors", "composition"]) {
		assert.doesNotMatch(viewLine, new RegExp(`stanza-editor-${foreignRow}`, "u"), foreignRow);
	}
	assert.match(viewLine, /stanza-editor-line-text/u);
	const viewOverlays = readFileSync(editorSource("browser/view/viewOverlays.ts"), "utf8");
	assert.match(viewOverlays, /new ViewPartRows/u);
	const currentLineHighlight = readFileSync(editorSource("browser/viewParts/currentLineHighlight/currentLineHighlight.ts"), "utf8");
	assert.doesNotMatch(currentLineHighlight, /new ViewPartRows/u);
	for (const part of ["decorations/decorations", "indentGuides/indentGuides", "linesDecorations/linesDecorations", "marginDecorations/marginDecorations", "selections/selections", "lineNumbers/lineNumbers"]) {
		const source = readFileSync(editorSource(`browser/viewParts/${part}.ts`), "utf8");
		assert.match(source, /extends (?:DynamicViewOverlay|DedupOverlay)/u, part);
		assert.match(source, /render\(startLineNumber: number, lineNumber: number\): string/u, part);
		assert.doesNotMatch(source, /new ViewPartRows/u, part);
	}
	const viewCursors = readFileSync(editorSource("browser/viewParts/viewCursors/viewCursors.ts"), "utf8");
	assert.match(viewCursors, /extends ViewPart/u);
	assert.match(viewCursors, /new ViewCursor\(/u);
	assert.doesNotMatch(viewCursors, /new ViewPartRows/u);
	const glyphMargin = readFileSync(join(editorRoot, 'browser/viewParts/glyphMargin/glyphMargin.ts'), 'utf8');
	assert.match(glyphMargin, /class DedupOverlay extends DynamicViewOverlay/u);
});

test("Stanza owns its public protocol and DOM vocabulary without renaming the editor domain", () => {
	const api = readFileSync(editorSource("editor.api.ts"), "utf8");
	const codeInput = readFileSync(join(workbenchRoot, "contrib/codeEditor/browser/codeEditorInput.ts"), "utf8");
	const codePane = readFileSync(join(workbenchRoot, "browser/parts/editor/textResourceEditor.ts"), "utf8");
	const codeEditorId = readFileSync(join(workbenchRoot, "common/editor/codeEditorId.ts"), "utf8");
	const documentInput = readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorInput.ts"), "utf8");
	const diffInput = readFileSync(join(workbenchRoot, "common/editor/diffEditorInput.ts"), "utf8");
	const viewport = readFileSync(editorSource("browser/view.ts"), "utf8");
	const structuredSurface = [
		readFileSync(resolve(desktopRoot, "extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8"),
		readFileSync(resolve(desktopRoot, "extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.css"), "utf8"),
		readFileSync(resolve(desktopRoot, "extensions/academic/browser/contrib/formatting/formattingContribution.ts"), "utf8"),
		readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorPane.ts"), "utf8"),
	].join("\n");
	assert.match(api, /Stable Stanza API for standalone editors/u);
	assert.match(codeInput, /CODE_EDITOR_ID/u);
	assert.match(codeEditorId, /stanza\.editor\.code/u);
	assert.match(codePane, /from ["'][^"']*common\/editor\/codeEditorId\.js["']/u);
	assert.match(documentInput, /stanza\.editor\.document/u);
	assert.match(diffInput, /stanza\.editor\.diff/u);
	assert.match(diffInput, /application\/vnd\.stanza\.editor-diff/u);
	assert.match(viewport, /stanza-editor/u);
	assert.match(structuredSurface, /stanza-document-/u);
	assert.match(structuredSurface, /stanza-structured-/u);
	assert.doesNotMatch(structuredSurface, /ash-(?:document|structured)-/u);
	assert.equal(existsSync(resolve(editorRoot, "../stanza")), false, "parallel stanza directory");
});

test("Stanza owns editor DOM and CSS brand classes", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") && !file.endsWith(".css")) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /\bmonaco-editor\b/u, relative(editorRoot, file));
	}
});

test("Frontend syntax sessions use the shared backend with a browser Worker fallback", () => {
	const packageManifest = readFileSync(resolve(desktopRoot, "package.json"), "utf8");
	const syntaxCrate = readFileSync(resolve(desktopRoot, "crates/syntax/src/lib.rs"), "utf8");
	const syntaxOperations = readFileSync(resolve(desktopRoot, "crates/app-server/src/server/request_processors/syntax.rs"), "utf8");
	const syntaxLibrary = readFileSync(join(workbenchRoot, "services/treeSitter/browser/treeSitterLibraryService.ts"), "utf8");
	const syntaxAdapter = readFileSync(join(workbenchRoot, "services/language/browser/appServerSyntaxProviders.ts"), "utf8");
	const sharedWorkbench = readFileSync(join(workbenchRoot, "browser/workbench.ts"), "utf8");
	const workbenchContributions = readFileSync(join(workbenchRoot, "workbench.common.main.ts"), "utf8");
	const academicContribution = readFileSync(resolve(desktopRoot, "extensions/academic/browser/editor.ts"), "utf8");
	const styling = readFileSync(editorSource("common/services/semanticTokensProviderStyling.ts"), "utf8");
	assert.match(packageManifest, /@vscode\/tree-sitter-wasm/u);
	assert.match(syntaxCrate, /SyntaxDocument/u);
	assert.match(syntaxOperations, /SyntaxDocument::open/u);
	assert.match(syntaxAdapter, /ISyntaxApi/u);
	assert.doesNotMatch(syntaxAdapter, /provideTokens|tokenPriority|LanguageTokenResult/u);
	assert.match(syntaxAdapter, /provideDiagnostics/u);
	assert.match(sharedWorkbench, /createSyntaxSession/u);
	assert.match(syntaxLibrary, /createAppServerTreeSitterSession/u);
	assert.match(syntaxLibrary, /if \(!isWeb \|\| this\.syntax\.isAvailable\)/u);
	assert.match(syntaxLibrary, /new Worker\(new URL\('\.\/treeSitterWorkerMain\.ts'/u);
	assert.doesNotMatch(sharedWorkbench, /new AppServerSyntaxProviders/u);
	assert.match(workbenchContributions, /new AppServerSyntaxProviders/u);
	assert.doesNotMatch(academicContribution, /AppServerSyntaxProviders/u);
	assert.match(styling, /LanguageToken/u);
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") || relative(editorRoot, file).split(sep).includes("test")) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /^import (?!type\b).*from ['"]@vscode\/tree-sitter-wasm['"]/mu, relative(editorRoot, file));
	}
});

test("Code Workbench composes code and Academic document contributions", () => {
	const codeBundle = readFileSync(editorSource("editor.code.all.ts"), "utf8");
	const standardBundle = readFileSync(editorSource("editor.all.ts"), "utf8");
	assert.match(codeBundle, /editor\.all/u);
	assert.doesNotMatch(codeBundle, /contrib\//u);
	assert.doesNotMatch(codeBundle, /contrib\/academic/u);
	assert.doesNotMatch(standardBundle, /documentEditor|paragraphStyle|paragraphFormatting/u);
	assert.match(standardBundle, /browser\/coreCommands/u);
	assert.doesNotMatch(standardBundle, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(standardBundle, /editor\.(?:code|academic)\.all/u);

	const browserEntry = readFileSync(resolve(editorRoot, "../code/browser/workbench/workbench.ts"), "utf8");
	const electronEntry = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/workbench.ts"), "utf8");
	const workbenchContributions = readFileSync(join(workbenchRoot, "workbench.common.main.ts"), "utf8");
	const academicContribution = readFileSync(resolve(desktopRoot, "extensions/academic/browser/editor.ts"), "utf8");
	for (const entry of [browserEntry, electronEntry]) {
		assert.doesNotMatch(entry, /WorkbenchMode|__ASH_WORKBENCH_MODE__/u);
		assert.doesNotMatch(entry, /applicationId|AshStorageApplicationId/u);
		assert.doesNotMatch(entry, /modeLoaders|modes\//u);
		assert.match(entry, /await import\([^)]*workbench\.(?:web|desktop)\.main/u);
		assert.match(entry, /sessions\/browser\/workbenchChat\.contribution/u);
		assert.doesNotMatch(entry, /if\s*\([^)]*(?:code|academic)/u);
		assert.doesNotMatch(entry, /editor\/editor\.(?:code|academic)\.all/u);
	}
	assert.match(workbenchContributions, /editor\/editor\.code\.all/u);
	assert.doesNotMatch(workbenchContributions, /standaloneGotoSymbolQuickAccess/u);
	assert.match(workbenchContributions, /contrib\/codeEditor\/browser\/codeEditor\.contribution/u);
	assert.match(workbenchContributions, /contrib\/tasks\/browser\/task\.contribution/u);
	const sessionsContributions = readFileSync(join(workbenchRoot, '../sessions/sessions.common.main.ts'), 'utf8');
	assert.match(sessionsContributions, /contrib\/tasks\/browser\/task\.contribution/u);
	assert.doesNotMatch(sessionsContributions, /registerTasksView/u);
	assert.match(sessionsContributions, /registerOutputView\(SessionsViewRegistry\)/u);
	assert.doesNotMatch(workbenchContributions, /registerTasksView/u);
	assert.doesNotMatch(readFileSync(join(workbenchRoot, 'browser/workbench.contribution.ts'), 'utf8'), /registerTasksView\(\)/u);
	assert.doesNotMatch(readFileSync(join(workbenchRoot, 'contrib/tasks/browser/task.contribution.ts'), 'utf8'), /^registerTasksView\(\);/mu);
	assert.match(workbenchContributions, /contrib\/testing\/browser\/testing\.contribution/u);
	assert.match(workbenchContributions, /contrib\/debug\/browser\/debug\.contribution/u);
	assert.doesNotMatch(workbenchContributions, /editor\/editor\.academic\.all/u);
	assert.match(academicContribution, /getEditorProfile/u);
	assert.doesNotMatch(academicContribution, /registerBuiltinEditorPane/u);
	const academicRegistration = readFileSync(resolve(desktopRoot, 'extensions/academic/src/lib.rs'), 'utf8');
	assert.match(academicRegistration, /use external_ext_sdk::editor_client::DOCUMENT_CLIENT_CHANNEL;/u);
	assert.match(academicRegistration, /context\.data_channels\.register\(\s*DOCUMENT_CLIENT_CHANNEL/u);
	assert.match(readFileSync(resolve(desktopRoot, 'sdk/rust/src/editor_client.rs'), 'utf8'), /pub const DOCUMENT_CLIENT_CHANNEL: &str = "editor\.client\.v1";/u);
	assert.doesNotMatch(workbenchContributions, /contrib\/academic\/browser\/academicEditor\.contribution/u);
	assert.match(workbenchContributions, /contrib\/documentEditor\/browser\/documentEditor\.contribution/u);
	const documentContribution = readFileSync(join(workbenchRoot, 'contrib/documentEditor/browser/documentEditor.contribution.ts'), 'utf8');
	assert.doesNotMatch(documentContribution, /registerEditorPane|createDefaultDocumentSchema|generalProfile/u);
	assert.match(documentContribution, /createGeneralDocument/u);
	assert.doesNotMatch(academicContribution, /workbench\/contrib\/(?:tasks|testing|debug)/u);
	assert.doesNotMatch(academicContribution, /workbench\/contrib\/extensionHost/u);
	assert.doesNotMatch(academicContribution, /editor\/editor\.code\.all/u);
	assert.doesNotMatch(workbenchContributions, /sessions\//u);
	assert.match(browserEntry, /await startBrowserWorkbench\(\{ productName: AshWorkbenchName/u);
	assert.match(electronEntry, /await main\(\{ productName: AshWorkbenchName/u);
});

test("Workbench entries select runtime services and load feature services through their contributions", () => {
	const workbench = readFileSync(join(workbenchRoot, "browser/workbench.ts"), "utf8");
	const workbenchContributions = readFileSync(join(workbenchRoot, "workbench.common.main.ts"), "utf8");
	const tasks = readFileSync(join(workbenchRoot, "contrib/tasks/browser/taskService.ts"), "utf8");
	const testing = readFileSync(join(workbenchRoot, "services/testing/browser/testingServiceRegistration.ts"), "utf8");
	const debug = readFileSync(join(workbenchRoot, "contrib/debug/browser/debugService.ts"), "utf8");
	const debugContribution = readFileSync(join(workbenchRoot, "contrib/debug/browser/debug.contribution.ts"), "utf8");
	const testingContribution = readFileSync(join(workbenchRoot, "contrib/testing/browser/testing.contribution.ts"), "utf8");
	assert.doesNotMatch(workbench, /services\/(?:tasks|testing|debug)\/(?:browser|common)/u);
	assert.doesNotMatch(workbench, /product\.id\s*===\s*["']code["']/u);
	assert.match(workbench, /installWorkbenchServiceContributions/u);
	for (const runtime of ["web", "desktop"]) {
		const entry = readFileSync(join(workbenchRoot, `workbench.${runtime}.main.ts`), "utf8");
		assert.match(entry, /import ["']\.\/workbench\.common\.main\.js["']/u);
	}
	assert.match(workbenchContributions, /contrib\/tasks\/browser\/task\.contribution/u);
	assert.match(readFileSync(join(workbenchRoot, "contrib/tasks/browser/task.contribution.ts"), "utf8"), /import ["']\.\/taskService\.js["']/u);
	assert.doesNotMatch(workbenchContributions, /contrib\/tasks\/browser\/taskService/u);
	assert.match(workbenchContributions, /api\/browser\/extensionHost\.contribution/u);
	assert.doesNotMatch(workbenchContributions, /extensionHostServiceRegistration/u);
	const extensionHostComposition = readFileSync(join(workbenchRoot, 'api/browser/extensionHost.contribution.ts'), 'utf8');
	assert.match(extensionHostComposition, /dependencies: \[IDebugService, ISpeechService, ITerminalService, ITerminalProfileService, ITerminalProfileResolverService/u);
	assert.match(workbenchContributions, /codebaseSymbolsServiceRegistration/u);
	assert.match(debugContribution, /import ["']\.\/debugService\.js["']/u);
	assert.match(testingContribution, /services\/testing\/browser\/testingServiceRegistration/u);
	assert.doesNotMatch(workbenchContributions, /testingServiceRegistration|contrib\/debug\/browser\/debugService/u);
	assert.equal(existsSync(resolve(workbenchRoot, "../code/browser/workbench/codeWorkbenchServices.ts")), false);
	for (const registration of [tasks, testing, debug]) assert.match(registration, /registerWorkbenchServiceContribution/u);
	for (const [contribution, entry] of [["tasks", "task"], ["testing", "testing"], ["debug", "debug"]]) assert.doesNotMatch(readFileSync(join(workbenchRoot, `contrib/${contribution}/browser/${entry}.contribution.ts`), "utf8"), /registerWorkbenchServiceContribution/u);
});

test("Code renderers select App Server debug transport without Electron debug IPC", () => {
	const browserCode = readFileSync(resolve(editorRoot, "../code/browser/workbench/workbench.ts"), "utf8");
	const electronCode = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/workbench.ts"), "utf8");
	const main = readFileSync(resolve(editorRoot, "../code/electron-main/main.ts"), "utf8");
	const sharedElectronRenderer = readFileSync(join(workbenchRoot, "electron-browser/rendererApi.ts"), "utf8");
	const sharedDisconnectedRenderer = readFileSync(join(workbenchRoot, "browser/rendererApi.ts"), "utf8");
	const sharedConnectedRenderer = readFileSync(join(workbenchRoot, "browser/webRendererApi.ts"), "utf8");
	const sharedElectronMain = readFileSync(resolve(editorRoot, "../code/electron-main/app.ts"), "utf8");
	assert.match(browserCode, /createAppServerDebugAdapterCapability/u);
	assert.match(electronCode, /createAppServerDebugAdapterCapability/u);
	assert.doesNotMatch(main, /debugAdapterIpcRoutes/u);
	const debugAdapter = readFileSync(resolve(editorRoot, "../platform/debug/browser/appServerDebugAdapterProcessService.ts"), "utf8");
	assert.match(debugAdapter, /implements IDebugAdapterProcessService/u);
	assert.match(debugAdapter, /appServerRequest/u);
	for (const sharedHost of [sharedElectronRenderer, sharedDisconnectedRenderer, sharedConnectedRenderer, sharedElectronMain]) assert.doesNotMatch(sharedHost, /new (?:Electron|Disconnected|ViteDev)DebugAdapterProcessService|debugAdapterIpcRoutes/u);
});

test("Editor widgets delegate optional feature composition to contributions", () => {
	const textHost = readFileSync(editorSource("browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	const coreCommands = readFileSync(editorSource("browser/coreCommands.ts"), "utf8");
	const findContribution = readFileSync(editorSource("contrib/find/browser/findController.ts"), "utf8");
	const quickAccessContribution = readFileSync(editorSource("contrib/quickAccess/browser/quickAccessController.ts"), "utf8");
	const documentHost = readFileSync(resolve(desktopRoot, "extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8");
	const documentContribution = readFileSync(resolve(desktopRoot, "extensions/academic/browser/documentContributions.ts"), "utf8");
	const codePaneContribution = readFileSync(join(workbenchRoot, "contrib/codeEditor/browser/codeEditor.contribution.ts"), "utf8");
	const academicPaneContribution = readFileSync(resolve(desktopRoot, "extensions/academic/browser/editor.ts"), "utf8");
	const textModel = readFileSync(editorSource("common/model/textModel.ts"), "utf8");
	const codeBundle = readFileSync(editorSource("editor.code.all.ts"), "utf8");
	const standardBundle = readFileSync(resolve(desktopRoot, 'src/ash/editor/editor.contrib.ts'), 'utf8') + readFileSync(resolve(desktopRoot, 'src/ash/editor/browser/editorFeatures.ts'), 'utf8');
	const editorExtensionRegistry = readFileSync(editorSource("browser/editorExtensions.ts"), "utf8");
	const codeEditorContributions = readFileSync(editorSource("browser/widget/codeEditor/codeEditorContributions.ts"), "utf8");
	const optionalControllerPattern = /(?:AnchorSelect|BlockComment|BracketEditing|BracketMatch|BracketNavigation|CodeAction|CodeLens|ColorPicker|ContextMenu|CursorUndo|DiagnosticHover|DiagnosticNavigation|EditorState|Folding|FontZoom|Format|GotoLine|GotoSymbol|Hover|InPlaceReplace|InlayHints|InlineCompletions|InlineProgress|LineComment|LineJoin|LineOperations|LinkedEditing|Links|Message|MiddleScroll|MultiCursor|OccurrenceHighlight|OccurrenceSelection|ParameterHints|ReadOnlyMessage|Rename|SectionHeaders|SmartSelect|StickyScroll|SymbolIcons|TextDrop|ToggleTabFocusMode|Tokenization|Transpose|UnicodeHighlighter|UnusualLineTerminators|WordWrap)Controller/u;
	assert.doesNotMatch(textHost, /from\s+["'][^"']*\/contrib\/(?:find|folding|hover|format|rename|codeAction|collaboration|formatting)\//u);
	assert.doesNotMatch(textHost, /EditorBrowserRuntime|IEditorBrowserRuntime/u);
	assert.doesNotMatch(textHost, /registerEditorBrowserFactory|EditorBrowserFactory/u);
	assert.match(textHost, /getEditorContributions/u);
	assert.match(codeEditorContributions, /runWhenWindowIdle/u);
	assert.doesNotMatch(textHost, optionalControllerPattern);
	assert.doesNotMatch(textHost, /EditingCommandController/u);
	assert.match(coreCommands, /editor\.action\.selectAll/u);
	assert.match(coreCommands, /registerEditorContribution/u);
	assert.doesNotMatch(textHost, /SuggestModel|RustSyntaxFactsService|LanguageDiagnosticDecorationBridge|TokenizationTextModelPart|TextDecorationCollection|LanguageBracketMatcher/u);
	const viewController = readFileSync(editorSource("browser/view/viewController.ts"), "utf8");
	const codeEditorWidget = readFileSync(editorSource("browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	assert.doesNotMatch(viewController, /from\s+["'][^"']*\/contrib\//u);
	assert.match(viewController, /this\._register\(addDisposableListener/u);
	assert.doesNotMatch(codeEditorWidget, /from\s+["'][^"']*\/contrib\//u);
	assert.doesNotMatch(editorExtensionRegistry, /from\s+["'][^"']*\/contrib\//u);
	assert.match(findContribution, /registerEditorContribution/u);
	assert.match(quickAccessContribution, /registerEditorContribution/u);
	assert.match(standardBundle, /find\/browser\/findController/u);
	assert.match(standardBundle, /quickAccess\/browser\/quickAccessController/u);
	for (const contribution of ["bracketMatching", "languageAnalysis", "tokenization", "unicodeHighlighter", "wordHighlighter"]) {
		assert.match(standardBundle, new RegExp(`contrib/${contribution}/browser/[^"']+\\.contribution`, "u"), contribution);
	}
	assert.doesNotMatch(standardBundle, /gotoSymbol\.contribution/u);
	assert.doesNotMatch(readFileSync(join(editorRoot, 'editor.main.ts'), 'utf8'), /standaloneGotoSymbolQuickAccess/u);
	assert.match(standardBundle, /contrib\/comment\/browser\/comment\.js/u);
	assert.match(standardBundle, /contrib\/suggest\/browser\/suggestController\.js/u);
	assert.match(standardBundle, /contrib\/gotoError\/browser\/gotoError\.js/u);
	assert.match(standardBundle, /contrib\/multicursor\/browser\/multicursor\.js/u);
	assert.match(standardBundle, /contrib\/codeAction\/browser\/codeActionContributions\.js/u);
	assert.match(standardBundle, /contrib\/hover\/browser\/hoverContribution\.js/u);
	assert.match(standardBundle, /contrib\/stickyScroll\/browser\/stickyScrollContribution\.js/u);
	assert.match(standardBundle, /contrib\/format\/browser\/formatActions\.js/u);
	assert.match(standardBundle, /contrib\/rename\/browser\/rename\.js/u);
	assert.match(standardBundle, /contrib\/parameterHints\/browser\/parameterHints\.js/u);
	assert.match(standardBundle, /contrib\/dropOrPasteInto\/browser\/dropIntoEditorContribution/u);
	assert.match(standardBundle, /contrib\/clipboard\/browser\/clipboard\.js/u);
	assert.match(standardBundle, /contrib\/folding\/browser\/folding\.js/u);
	assert.doesNotMatch(codeBundle, /contrib\//u);
	assert.doesNotMatch(codePaneContribution, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(documentHost, /from\s+["'][^"']*\/contrib\/(?:formatting|collaboration)\/browser\//u);
	assert.match(documentHost, /this\.options\.contributions/u);
	assert.doesNotMatch(documentHost, /registerDocumentEditorContributionFactory/u);
	assert.match(documentContribution, /documentContributions/u);
	assert.match(documentContribution, /FormattingContribution/u);
	assert.doesNotMatch(documentContribution, /CollaborationContribution/u);
	const documentPane = readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorPane.ts"), "utf8");
	assert.match(documentPane, /new CollaborationContribution/u);
	assert.doesNotMatch(academicPaneContribution, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(academicPaneContribution, /contrib\/codeEditor|CodeEditorPane|EmbeddedTextEditorFactory|AcademicCodeBlockEditorFactory|CodeEditorWidget/u);
	assert.doesNotMatch(academicPaneContribution, /documentEditor\.contribution/u);
	assert.doesNotMatch(textModel, /DocumentSchema|TextModelBlock|projectDocumentToLines/u);
	assert.match(textModel, /get lineDocument/u);
	assert.match(textModel, /getLineId/u);
	assert.doesNotMatch(textModel, /TextModelStructure|structureIndex|TextModelBlockTree/u);
	assert.match(documentHost, /case "codeBlock":[\s\S]*appendEditableText/u);
	assert.doesNotMatch(documentHost, /new TextModel|TextModel\.createStructured/u);
	assert.doesNotMatch(standardBundle, /codeEditorPart\.contribution/u);
});

test("Multi-diff keeps generic projection in Editor and product integration in Workbench", () => {
	const widget = readFileSync(editorSource("browser/widget/multiDiffEditor/multiDiffEditorWidget.ts"), "utf8");
	const pane = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditor.ts"), "utf8");
	const input = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditorInput.ts"), "utf8");
	const contribution = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditor.contribution.ts"), "utf8");
	const sharedWorkbench = readFileSync(join(workbenchRoot, "browser/workbench.contribution.ts"), "utf8");
	assert.doesNotMatch(widget, /workbench/u);
	assert.match(pane, /MultiDiffEditorWidget/u);
	assert.match(input, /EditorInput/u);
	assert.match(contribution, /registerEditorPane/u);
	assert.match(contribution, /registerAction2/u);
	assert.match(sharedWorkbench, /contrib\/multiDiffEditor/u);
});

test("Contribution entrypoints own registration rather than forwarding modules", () => {
	for (const file of collectFiles(join(editorRoot, 'contrib')).filter(file => file.endsWith('.contribution.ts'))) {
		const source = readFileSync(file, 'utf8');
		assert.match(source, /register(?:EditorContribution|EditorAction|Action2)\(/u, relative(editorRoot, file));
	}
});

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
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function isTestFile(file: string): boolean {
	return /[\\/]test[\\/]|\.test\.ts$/u.test(file);
}

function editorSource(file: string): string {
	return join(editorRoot, file);
}
