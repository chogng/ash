import { WebWorkerService } from '../../../src/ash/platform/webWorker/browser/webWorkerServiceImpl.js';
import { rustSyntaxFixture, disconnectRustSyntaxFixture, reconnectRustSyntaxFixture } from '../../fixtures/browser/rustSyntaxHostFixture.js';
import { createDisconnectedSyntaxApi } from '../../../src/ash/platform/syntax/browser/syntaxApi.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBuiltinExtensionFixture } from '../../fixtures/browser/builtinExtensionsFixture.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/editor.json' with { type: 'json' };
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
import { TreeSitterLibraryService, createTreeSitterSyntaxSession } from '../../../src/ash/workbench/services/treeSitter/browser/treeSitterLibraryService.js';

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? chinese : {});
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
const library = store.add(new TreeSitterLibraryService(syntax, new WebWorkerService()));
const errors: string[] = [];
let model: TextModel;
let inspection: Promise<unknown> = Promise.resolve();
const editor = store.add(services.createInstance(CodeEditorWidget, { container: document.getElementById('editor')!, model: null }));
function open(language: string, text: string): void {
	const previous = model;
	model = new TextModel(text, {
		languageId: language,
		tokenization: {
			createSyntaxSession: value => createTreeSitterSyntaxSession(value, configuration, library, syntaxTheme),
			onDidChangeSyntaxBackend: library.onDidChange,
		},
	});
	model.tokenization.onDidEncounterError(error => errors.push(String(error)));
	editor.setModel(model);
	editor.layout({ width: 800, height: 400 });
	previous?.dispose();
}
open('python', 'def greet(name):\n    return "你好🙂"\n');
const integration = {
	open,
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
