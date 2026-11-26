import { languagePackCatalog as chineseCatalog } from '../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import { WebWorkerService } from '../../../src/ash/platform/webWorker/browser/webWorkerServiceImpl.js';
import { rustSyntaxFixture, rustSyntaxClientFixture, disconnectRustSyntaxFixture, reconnectRustSyntaxFixture } from '../../fixtures/browser/rustSyntaxHostFixture.js';
import { createDisconnectedSyntaxApi } from '../../../src/ash/platform/syntax/browser/syntaxApi.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBuiltinExtensionFixture } from '../../fixtures/browser/builtinExtensionsFixture.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import '../../../src/ash/editor/editor.main.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TreeSitterLibraryService, TreeSitterSyntaxProviders, createTreeSitterSyntaxSession } from '../../../src/ash/workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { CodeHighlightingService, createCodeHighlightingProvider } from '../../../src/ash/workbench/services/codeHighlighting/browser/codeHighlightingService.js';
import { createAppServerResourceApi, createAppServerServerEventApi } from '../../../src/ash/platform/agentHost/browser/appServerApi.js';
import { createAppServerExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { createAppServerPluginManagementApi } from '../../../src/ash/platform/extensionManagement/browser/pluginManagementApi.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import { AdapterManager } from '../../../src/ash/workbench/contrib/debug/browser/debugAdapterManager.js';
import { URI } from '../../../src/ash/base/common/uri.js';

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? chineseCatalog.bundles : {});
const store = new DisposableStore();
const defaultThemes = store.add(new ExtensionColorThemeService(createBuiltinExtensionFixture(), { subscribe: () => ({ dispose() { } }) }));
await defaultThemes.start();
await import('../../../src/ash/workbench/contrib/codeEditor/browser/inspectEditorTokens/inspectEditorTokens.js');
const services = store.add(StandaloneServices.initialize());
services.themeService.setTheme('vs-dark');
const syntaxTheme = services.get(IThemeService);
services.registerInstance(IAccessibleViewService, store.add(services.createInstance(AccessibleViewService)));
const configuration = services.get(IConfigurationService);
const syntax = new URL(location.href).searchParams.get('backend') === 'offline'
	? createDisconnectedSyntaxApi(operation => { throw new Error(`Unexpected offline syntax request: ${operation}`); })
	: await rustSyntaxFixture();
const workers = new WebWorkerService();
const library = store.add(new TreeSitterLibraryService(syntax, workers));
const highlighter = store.add(new CodeHighlightingService(workers, syntaxTheme));
const zigUri = URI.file('/fixture/main.zig');
const zigExtension = new URL(location.href).searchParams.has('zig-extension');
if (zigExtension) store.add(services.languageFeaturesService.syntaxProvider.register(createCodeHighlightingProvider(highlighter)));
const pluginApi = zigExtension ? startPluginFixture() : undefined;
async function startPluginFixture() {
	const connection = await rustSyntaxClientFixture();
	const api = createAppServerExtensionApi(connection, createAppServerResourceApi(connection));
	const extensions = store.add(new AppServerExtensionService({
		api: {
			...api, list: async reload => {
				const catalog = await api.list(reload);
				return { ...catalog, extensions: catalog.extensions.filter(extension => extension.sourceKind === 'plugin') };
			}
		},
		eventApi: createAppServerServerEventApi(connection),
		languageService: services.languageService,
		languageConfigurationService: services.languageConfigurationService,
		replaceTreeSitterGrammars: grammars => library.replaceExtensionGrammars(grammars),
	}, createEmptyTestLanguagePacks(), store.add(new AdapterManager())));
	store.add(new TreeSitterSyntaxProviders(services.languageFeaturesService, library));
	await extensions.start();
	return createAppServerPluginManagementApi(connection);
}
const errors: string[] = [];
let model: TextModel;
let inspection: Promise<unknown> = Promise.resolve();
const editor = store.add(services.createInstance(CodeEditorWidget, { container: document.getElementById('editor')!, model: null }));
function open(language: string, text: string, detectZigFile = false): void {
	const previous = model;
	model = new TextModel(text, {
		resource: detectZigFile ? zigUri : undefined,
		languageId: language,
		tokenization: {
			...(zigExtension ? { syntaxProviderRegistry: services.languageFeaturesService.syntaxProvider } : {}),
			createSyntaxSession: value => createTreeSitterSyntaxSession(value, configuration, library, syntaxTheme),
			onDidChangeSyntaxBackend: library.onDidChange,
		},
	});
	if (detectZigFile) model.setLanguage(services.languageService.createByFilepathOrFirstLine(zigUri));
	model.tokenization.onDidEncounterError(error => errors.push(String(error)));
	editor.setModel(model);
	editor.layout({ width: 800, height: 400 });
	previous?.dispose();
}
open('python', 'def greet(name):\n    return "你好🙂"\n');
const integration = {
	open,
	highlightChatCode: async (language: string, text: string) => (await highlighter.highlight(language, text, new AbortController().signal)).tokens
		.map(token => ({ type: token.tokenType, text: text.split('\n')[token.range.startLineNumber - 1]!.slice(token.range.startColumn - 1, token.range.endColumn - 1) })),
	installSyntaxPlugin: async () => {
		const api = (await pluginApi)!;
		const { revision } = await api.list();
		const { id, version, digest, command } = await api.installLocal({ path: 'syntax-plugin', dirId: null, expectedRevision: revision, commandId: crypto.randomUUID() });
		const granted = await api.grant({ id, version, digest, expectedRevision: command.revision, commandId: crypto.randomUUID() });
		await api.enable({ id, version, digest, expectedRevision: granted.revision, commandId: crypto.randomUUID() });
		return id;
	},
	uninstallSyntaxPlugin: async (pluginId: string) => {
		const api = (await pluginApi)!;
		const catalog = await api.list();
		const { id, version, digest } = catalog.packages.find(plugin => plugin.id === pluginId)!;
		const disabled = await api.disable({ id, version, digest, expectedRevision: catalog.revision, commandId: crypto.randomUUID() });
		const revoked = await api.revokeGrant({ id, version, digest, expectedRevision: disabled.revision, commandId: crypto.randomUUID() });
		await api.uninstall({ id, version, digest, expectedRevision: revoked.revision, commandId: crypto.randomUUID() });
		return (await api.list()).packages.some(plugin => plugin.id === id);
	},
	disconnectBackend: disconnectRustSyntaxFixture,
	reconnectBackend: reconnectRustSyntaxFixture,
	ready: () => model.tokenization.whenReady(new AbortController().signal),
	facts: () => model.tokenization.syntaxTree!.getFacts(new AbortController().signal),
	state: () => ({
		language: model.getLanguageId(),
		shared: !!model.tokenization.syntaxTree,
		execution: model.tokenization.syntaxTree?.execution,
		text: model.getValue(),
		version: model.version,
		lines: model.getLineCount(),
		errors,
		tokens: model.tokenization.lines.flatMap(line => line.tokens.map(token => ({ type: token.tokenType, text: model.getValueInRange(token.range) }))),
	}),
	edit: () => { editor.pushUndoStop(); editor.executeEdits('test', [{ range: new Range(2, 13, 2, 13), text: 'updated ' }]); editor.pushUndoStop(); },
	undo: () => model.undo(),
	inspect: (lineNumber: number, column: number) => {
		editor.setPosition({ lineNumber, column });
		editor.focus();
		inspection = services.get(ICommandService).executeCommand('editor.action.inspectTMScopes').catch(error => errors.push(String(error)));
	},
	waitForInspection: () => inspection,
	showInspectionHelp: () => services.get(IAccessibleViewService).show(AccessibleViewType.Help),
	focused: () => editor.hasTextFocus(),
	dispose: () => { editor.setModel(null); model.dispose(); store.dispose(); },
};
Object.assign(window, { treeSitterIntegration: integration });
declare global { interface Window { treeSitterIntegration: typeof integration; } }
