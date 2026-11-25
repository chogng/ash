import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { IDialogService, IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialogHandler.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { MenuService } from '../../../src/ash/platform/actions/common/menuService.js';
import { IMenuService } from '../../../src/ash/platform/actions/common/actions.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { registerTestTitlebarServices } from '../../../src/ash/workbench/test/common/testTitlebarServices.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { BrowserContextMenuService } from '../../../src/ash/platform/contextview/browser/contextMenuService.js';
import { IContextMenuService, IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { INotificationService, Severity } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
import { AppServerPdfService } from '../../../src/ash/platform/pdf/browser/appServerPdfService.js';
import { IPdfService } from '../../../src/ash/platform/pdf/common/pdfService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { createTestFileService, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { IEditorPart } from '../../../src/ash/workbench/browser/parts/editor/editorPart.js';
import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { EditorPanes as EditorPaneHost } from '../../../src/ash/workbench/browser/parts/editor/editorPanes.js';
import type { IEditorPaneWithViewState } from '../../../src/ash/workbench/browser/parts/editor/editorWithViewState.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { languagePackCatalog as chineseCatalog } from '../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import { bindTestColorTheme } from '../../fixtures/browser/themeFixture.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { pdfScrollModeSetting } from '../../../src/ash/sessions/contrib/pdf/browser/pdfConfiguration.js';
import { IPdfWorkingCopyService, PdfWorkingCopyService } from '../../../src/ash/sessions/contrib/pdf/browser/pdfWorkingCopyService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { ChatResponseResourceFileSystemProvider, ChatResponseResourceWorkbenchContribution, IChatResponseResourceFileSystemProvider } from '../../../src/ash/workbench/contrib/chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { BrowserLifecycleService } from '../../../src/ash/workbench/services/lifecycle/browser/lifecycleService.js';
import { ILifecycleService } from '../../../src/ash/workbench/services/lifecycle/common/lifecycle.js';
import { IViewDescriptorService, WorkbenchViewRegistry } from '../../../src/ash/workbench/common/views.js';
import { ViewDescriptorService } from '../../../src/ash/workbench/services/views/browser/viewDescriptorService.js';
import '../../../src/ash/sessions/contrib/pdf/browser/pdf.contribution.js';
import '../../../src/ash/sessions/browser/ui/filterTabs.css';
import '../../../src/ash/base/browser/ui/button/button.css';

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public on(event: string, listener: (value: unknown) => void): void {
		const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners);
	}
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'pdf', workspaceRoot: '/fixture' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as { id?: number; method: string; params: unknown; };
		if (request.id === undefined) { return; }
		if (request.method === 'initialize') {
			const result = createTestInitializeResult();
			result.capabilities.contracts.pdf = { version: 1 };
			result.capabilities.contracts.pdfOutline = { version: 1 };
			this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
			return;
		}
		void fetch('/__aspdf_rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
			.then(response => response.json()).then(reply => this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', ...reply }) }));
	}
	private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
}

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? chineseCatalog.bundles : {});
const services = new InstantiationService();
const viewsRegistry = new WorkbenchViewRegistry({ registerActions: false });
services.registerSingleton(IViewDescriptorService, () => services.createInstance(ViewDescriptorService, { registry: viewsRegistry }));
const clipboard = new BrowserClipboardService(navigator.clipboard);
services.registerInstance(IClipboardService, clipboard);
const dialogs = new DialogService();
services.registerInstance(IDialogService, dialogs);
const dialogHandler = new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body));
let chatDraft = '';
services.registerInstance(IChatSessionNavigationService, {
	appendToActiveDraft(text) { chatDraft += text; },
} satisfies Pick<IChatSessionNavigationService, 'appendToActiveDraft'> as IChatSessionNavigationService);
let readOnlyFile: string | undefined;
const memory = new class extends InMemoryFileSystemProvider {
	override async stat(resource: URI) {
		return { ...await super.stat(resource), readonly: resource.path === readOnlyFile };
	}
}();
const files = createTestFileService(memory);
services.registerInstance(IFileService, files); registerTestComponentServices(services);
const configuration = new TestConfigurationService();
services.registerInstance(IConfigurationService, configuration);
const initialMode = new URL(location.href).searchParams.get('scrollMode');
if (initialMode) { await configuration.updateValue(pdfScrollModeSetting, initialMode, ConfigurationTarget.USER_LOCAL); }
services.registerSingleton(IContextKeyService, () => new ContextKeyService());
const notifications = services.createInstance(NotificationService);
services.registerInstance(INotificationService, notifications);
registerTestTitlebarServices(services);
const commands = new CommandService(services);
services.registerInstance(ICommandService, commands);
services.registerInstance(IMenuService, services.createInstance(MenuService));
const contextViews = new BrowserContextViewService(document.body);
services.registerInstance(IContextViewService, contextViews);
const menus = services.createInstance(BrowserContextMenuService);
services.registerInstance(IContextMenuService, menus);
services.registerSingleton(IWorkingCopyService, () => services.createInstance(BrowserWorkingCopyService));
services.registerSingleton(IPdfWorkingCopyService, () => services.createInstance(PdfWorkingCopyService));
const theme = bindTestColorTheme(services.get(IThemeService), document.body);
const client = new AppServerProtocolClient(new Transport());
await client.connect();
services.registerInstance(IPdfService, new AppServerPdfService(client));
const resource = URI.file('/fixture/review.pdf');
const reviewCopy = URI.file('/fixture/review-copy.pdf');
const unexpectedDialog = async (): Promise<never> => { throw new Error('Unexpected file dialog'); };
services.registerInstance(IFileDialogService, {
	pickFolderAndOpen: unexpectedDialog,
	pickWorkspaceAndOpen: unexpectedDialog,
	pickFileToSave: unexpectedDialog,
	showSaveConfirm: unexpectedDialog,
	showOpenDialog: unexpectedDialog,
	showSaveDialog: async () => reviewCopy,
});
await memory.createDirectory(URI.file('/fixture'));
const original = new Uint8Array(await (await fetch('/__aspdf_bytes')).arrayBuffer());
await memory.writeFile(resource, original, { create: true, overwrite: false });
let pane: EditorPane | undefined;
let split: EditorPane | undefined;
let toolResponse: ReturnType<IChatResponseResourceFileSystemProvider['associate']> | undefined;
const viewer = document.getElementById('viewer')!;
async function openPdf(input: IResourceEditorInput): Promise<EditorPane> {
	pane?.dispose();
	const descriptor = EditorPanes.getEditorPane(input)!;
	const resolved = descriptor.createInput?.(input) ?? input;
	pane = await descriptor.create({ input: resolved, instantiationService: services });
	pane.create(viewer); pane.setVisible(true);
	pane.layout({ width: viewer.clientWidth, height: viewer.clientHeight });
	await pane.setInput(resolved, new AbortController().signal);
	return pane;
}
services.registerInstance(ILogService, new NullLoggerService());
services.registerSingleton(ILifecycleService, () => services.createInstance(BrowserLifecycleService, { ownerWindow: window, onError: console.error }));
const editorPart: Pick<IEditorPart, 'domNode' | 'openEditor'> = { domNode: viewer, openEditor: openPdf };
services.registerInstance(IEditorPart, editorPart as IEditorPart);
services.registerSingleton(IChatResponseResourceFileSystemProvider, () => services.createInstance(ChatResponseResourceFileSystemProvider));
const responseFiles = services.createInstance(ChatResponseResourceWorkbenchContribution);
const contributions = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.pdfPreview.backup']);
contributions.advance(WorkbenchPhase.BlockRestore);
const pdfTest = {
	async createWithPaneHost() {
		const input = { resource, readOnly: true };
		const editor = await EditorPanes.getEditorPane(input)!.create({ input, instantiationService: services });
		using host = new EditorPaneHost(document.getElementById('viewer')!);
		host.create(editor);
	},
	async open(readOnly = false, name = 'review.pdf') {
		const target = URI.file(`/fixture/${name}`);
		readOnlyFile = readOnly ? target.path : undefined;
		if (target.path !== resource.path && target.path !== reviewCopy.path) {
			await memory.writeFile(target, original, { create: true, overwrite: true });
		}
		await openPdf({ resource: target });
	},
	async openToolResponse() {
		toolResponse = services.get(IChatResponseResourceFileSystemProvider).associate(original, { name: 'tool-report.pdf' });
		await openPdf({ resource: toolResponse.resource, contentType: 'application/pdf' });
		return toolResponse.resource.toString();
	},
	retireToolResponse() { toolResponse?.dispose(); toolResponse = undefined; },
	async hasBackup(resource: string, contents?: string) {
		const backup = await services.get(IPdfWorkingCopyService).backups.resolve(URI.parse(resource));
		return backup !== undefined && (contents === undefined || backup.content.includes(contents));
	},
	async restoreWorkspace() { await contributions.workspaceRestored(); },
	resize(width: number, height: number) {
		const host = document.getElementById('viewer')!; host.style.width = `${width}px`; host.style.height = `${height}px`;
		pane?.layout({ width, height });
	},
	dirty() { return pane?.workingCopy?.isDirty ?? false; },
	chatDraft() { return chatDraft; },
	errors() { return notifications.model.getNotifications().filter(item => item.severity === Severity.Error).map(item => item.message); },
	setScrollMode(value: unknown) { return configuration.updateValue(pdfScrollModeSetting, value, ConfigurationTarget.USER_LOCAL); },
	async scrollPreference() { return { value: configuration.getValue(pdfScrollModeSetting), source: (await configuration.read()).source }; },
	viewState() { return (pane as EditorPane & IEditorPaneWithViewState).saveViewState(); },
	restoreViewState(state: unknown) { (pane as EditorPane & IEditorPaneWithViewState).restoreViewState(state); },
	async externalWrite() { await memory.writeFile(resource, new Uint8Array([...original, ...new TextEncoder().encode('\n% external change\n')]), { create: false, overwrite: true }); },
	async hasExternalBytes() { return new TextDecoder().decode((await memory.readFile(resource)).bytes).includes('% external change'); },
	async revert() { await pane?.workingCopy?.revert(new AbortController().signal); },
	async split() {
		const container = document.createElement('main'); container.id = 'split'; container.style.height = '800px'; document.body.append(container);
		const input = { resource };
		split = await EditorPanes.getEditorPane(input)!.create({ input, instantiationService: services });
		split.create(container); split.setVisible(true); await split.setInput(input, new AbortController().signal);
	},
	closeFirst() { pane?.dispose(); pane = split; split = undefined; },
	async saved() { const bytes = (await memory.readFile(resource)).bytes; return { changed: String(bytes) !== String(original), pdf: new TextDecoder().decode(bytes.slice(0, 8)).startsWith('%PDF-') }; },
	colorTheme(scheme: 'light' | 'dark' | 'hcDark' | 'hcLight') {
		(services.get(IThemeService) as TestThemeService).setColorTheme({ light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[scheme]);
	},
	highContrast() { (services.get(IThemeService) as TestThemeService).setColorTheme(highContrastDarkColorTheme); },
	dispose() { contributions.dispose(); pane?.dispose(); split?.dispose(); toolResponse?.dispose(); responseFiles.dispose(); client.dispose(); menus.dispose(); contextViews.dispose(); commands.dispose(); configuration.dispose(); theme.dispose(); notifications.dispose(); services.dispose(); viewsRegistry.dispose(); files.dispose(); memory.dispose(); dialogHandler.dispose(); dialogs.dispose(); clipboard.dispose(); },
};
window.aspdfTest = pdfTest;
declare global {
	interface Window { aspdfTest: typeof pdfTest; }
}
