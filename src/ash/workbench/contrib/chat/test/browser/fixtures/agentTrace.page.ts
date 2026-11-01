import { IDiffService } from '../../../../../../workbench/services/diff/common/diffService.js';
import { DiffService } from '../../../../../../workbench/services/diff/browser/diffService.js';
import { DiffEditorWidget } from '../../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IChatSessionNavigationService } from '../../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { registerTestCodeEditorFeatures } from '../../../../../../../../test/fixtures/codeEditorFeatures.js';
const codeFeatures = registerTestCodeEditorFeatures();
import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import '../../../../../../base/browser/ui/button/button.css';
import '../../../../../../base/browser/ui/inputbox/inputbox.css';
import '../../../../../../base/browser/ui/iconlabel/iconlabel.css';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { LanguageService } from '../../../../../../editor/common/services/languageService.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { createBuiltinExtensionFixture } from '../../../../../../../../test/fixtures/browser/builtinExtensionsFixture.js';
import { StandaloneServiceCollection } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import '../../../../../../editor/editor.all.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { setIconResolver } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../../platform/theme/common/iconRegistry.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { ChatDebugEditor } from '../../../browser/chatDebug/chatDebugEditor.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IChatDebugService } from '../../../common/chatDebugService.js';
import { ExtensionColorThemeService } from '../../../../../services/extensions/browser/extensionColorThemeService.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { BrowserHostColorSchemeService } from '../../../../../services/themes/browser/browserHostColorSchemeService.js';
import { WorkbenchThemeService } from '../../../../../services/themes/browser/workbenchThemeService.js';
import { IHostColorSchemeService } from '../../../../../services/themes/common/hostColorSchemeService.js';

declare global {
	interface Window {
		agentTraceIntegration: {
			setTheme(id: string): Promise<void>;
			dispose(): void;
			accessibleContent(): string;
			diffValues(): { original: string; modified: string; } | undefined;
			resources(): { models: number; editors: number; };
			layout(width: number, height: number): void;
		};
	}
}

const resources = new DisposableStore();
const extensionThemes = resources.add(new ExtensionColorThemeService(createBuiltinExtensionFixture(), { subscribe: () => ({ dispose() { } }) }));
await extensionThemes.start();
const root = document.querySelector<HTMLElement>('#root')!;
setIconResolver(document, getIconDefinition);
const editorServices = resources.add(new StandaloneServiceCollection({}));
const services = resources.add(editorServices.createChild());
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(ILanguageService, resources.add(new LanguageService()));
services.registerInstance(IHostColorSchemeService, resources.add(new BrowserHostColorSchemeService(window)));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'agent-trace-theme', flushInterval: 0 })));
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
// This fixture imports a test-owned capture; any accidental live read must fail.
services.registerInstance(IChatService, {
	onDidChangeSession: Event.None,
	onDidUpdateThread: Event.None,
	onDidBecomeReady: Event.None,
} as unknown as IChatService);
const rejectLiveRead = async (): Promise<never> => { throw new Error('Imported trace fixtures must not read live captures'); };
services.registerSingleton(IDiffService, () => services.createInstance(DiffService));
services.registerInstance(IChatSessionNavigationService, { openConversation: async () => { } } as unknown as IChatSessionNavigationService);
services.registerInstance(IChatDebugService, {
		onDidChangeAvailableSessionResources: Event.None,
		getAvailableSessionResources: () => [URI.parse('ash-agent-trace:/catalog-fixture')], getHistoricalSessionTitle: () => 'Catalog fixture',
		readSession: async sessionId => ({ sessionId, title: 'Catalog fixture', status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [{ threadId: 'root', title: 'Root', status: 'active' }] }),
		exportWireLog: async () => { throw new Error('Fixture must not export Wire capture'); },
		startWireLog: async () => { throw new Error('Fixture must not start Wire capture'); },
		stopWireLog: async () => { },
		readWireLog: async () => { throw new Error('Fixture has no Wire capture'); },
		refreshAvailableSessions: async () => { },
	readTrace: async sessionId => { if (sessionId !== 'catalog-fixture') { return rejectLiveRead(); } return { trace: { formatVersion: 3, sessionId, threads: [], historyPrefixes: [] }, cursors: {}, hasMore: false }; },
	readTraceDiagnostics: async sessionId => { if (sessionId !== 'catalog-fixture') { return rejectLiveRead(); } return { diagnostics: { formatVersion: 2, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, events: [] }, cursor: 0, hasMore: false }; },
	readTracePayload: rejectLiveRead,
	readTraceGraph: rejectLiveRead,
});
const themes = resources.add(services.createInstance(WorkbenchThemeService, root));
themes.initialize();
services.registerInstance(IThemeService, themes);
services.registerInstance(IEditorService, {
	openEditor: async (input: import('../../../../../common/editor.js').IResourceEditorInput) => { await editor.setInput(input, new AbortController().signal); },
} as unknown as IEditorService);
const editor = resources.add(services.createInstance(ChatDebugEditor));
editor.create(root);
editor.layout({ width: 900, height: 650 });
await editor.setInput({ resource: URI.parse('ash-agent-trace:/import') }, new AbortController().signal);
resources.add(new Button(root, { label: 'Reference secondary button', presentation: 'secondary' }));
const models = services.get(IModelService);
const codeEditors = services.get(ICodeEditorService);
window.agentTraceIntegration = {
	async setTheme(id: string): Promise<void> { await themes.setColorTheme(id, 'themePicker'); },
	dispose(): void { resources.dispose(); },
	accessibleContent: () => editor.getAccessibleContent(),
	diffValues: () => { const control = editor.getControl(); return control instanceof DiffEditorWidget ? { original: control.getOriginalEditor().getModel()?.getValue() ?? '', modified: control.getModifiedEditor().getModel()?.getValue() ?? '' } : undefined; },
	resources: () => ({ models: models.getModels().length, editors: codeEditors.listCodeEditors().length }),
	layout: (width, height) => editor.layout({ width, height }),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
