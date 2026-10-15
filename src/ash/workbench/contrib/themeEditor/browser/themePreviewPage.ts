import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { LogService } from '../../../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../../../platform/log/common/consoleLogSink.js';
import type { ITerminalChildProcess, IProcessReadyEvent } from '../../../../platform/terminal/common/terminal.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { startWorkbench } from '../../../browser/workbench.js';
import { BrowserTitleService, createBrowserTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { InMemoryWorkingCopyBackupService } from '../../../services/workingCopy/common/workingCopyBackupService.js';
import { BrowserURLService } from '../../../services/url/browser/urlService.js';
import { ITerminalService, ITerminalGroupService } from '../../../services/terminal/browser/terminal.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { createThemePreviewHost, connectThemePreview } from './themePreviewHost.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';

const host = await createThemePreviewHost();
const { resources, root, workspaceFiles, workspaceRoot, samples, storage, api, clipboard, serviceCollection } = host;
// Code preview owns no conversations or media. Shared Chat contributions can
// observe that empty scope without borrowing the enclosing product's history.
const chatUnavailable = () => new Error(localize('themeEditor.previewChatUnavailable', 'Chat is unavailable in this preview.'));
serviceCollection.set(IChatSessionNavigationService, {
	getConversations: () => [], getActiveConversation: () => undefined,
	captureActiveDraft: async () => undefined,
	appendToActiveDraft: () => { throw chatUnavailable(); },
	openConversation: async () => { throw chatUnavailable(); },
	startVoiceConversation: async () => { throw chatUnavailable(); },
});
await import('../../../workbench.web.main.js');
let services!: IInstantiationService;
serviceCollection.set(IFileDialogService, host.fileDialogDescriptor(() => services));
const workbench = resources.add(await startWorkbench({
	productName: 'Ash', container: root, api, serviceCollection,
	extensionHost: api.extensionHost,
	workspace: { id: 'theme-preview', folders: [{ id: 'theme-preview', name: 'theme-preview', uri: workspaceRoot, index: 0 }] },
	workspaceFileSystemProvider: workspaceFiles,
	defaultLayout: { parts: { sidebar: true, panel: false, auxiliarybar: false, agentSidebar: false } },
	initialConfiguration: { "contents": { "workbench": { "startupEditor": "none" } }, "keys": ["workbench.startupEditor"], "overrides": [] },
	// Webviews are not part of the sample. The disconnected host supplies no remote resources.
	environmentService: { webviewExternalEndpoint: 'https://{{uuid}}.invalid' },
	clipboardService: clipboard,
	createStorageService: async () => storage,
	createUserDataFileSystemProvider: async () => new InMemoryFileSystemProvider(),
	createWorkingCopyBackupService: (_services, workspaceId) => new InMemoryWorkingCopyBackupService(workspaceId),
	createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
	createLifecycleService: host.createLifecycleService,
	createContextMenuService: scope => scope.createInstance(BrowserContextMenuService),
	createTitleService: (container, productName, groups, scope) => scope.createInstance(BrowserTitleService, container, productName, createBrowserTitlebarPart, groups),
	createURLService: scope => {
		host.restrictOpeners(scope);
		return scope.createInstance(BrowserURLService, undefined);
	},
	createWindow: scope => { services = scope; return Disposable.None; },
}));
await workbench.whenRestored;
const editorService = services.get(IEditorService);
for (const sample of [...samples].reverse()) {
	await editorService.openEditor({ resource: URI.joinPath(workspaceRoot, sample.name) }, { pinned: true, preserveFocus: true });
}

// The real Terminal UI consumes a renderer-owned process. Its input can only
// manipulate this sample buffer; no string is ever sent to a shell.
class PreviewTerminalProcess extends Disposable implements ITerminalChildProcess {
	readonly shouldPersist = false;
	private readonly data = this._register(new Emitter<string>());
	private readonly ready = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessData = this.data.event;
	readonly onProcessReady = this.ready.event;
	readonly onDidChangeProperty = Event.None;
	readonly onProcessExit = Event.None;
	private line = '';
	constructor(readonly id: number) { super(); }
	async start(): Promise<void> {
		this.ready.fire({ pid: -1, cwd: '/theme-preview' });
		this.data.fire(localize('themeEditor.previewTerminalIntro', 'Preview terminal. Try help, clear or echo. Commands stay in this preview.') + '\r\n\x1b[31m● \x1b[32m● \x1b[33m● \x1b[34m● \x1b[35m● \x1b[36m●\x1b[0m\r\n$ ');
	}
	input(data: string): void {
		if (data === '\r') {
			const output = this.line === 'clear' ? '\x1b[2J\x1b[H' : this.line === 'help' ? 'help, clear, echo <text>' : this.line.startsWith('echo ') ? this.line.slice(5) : this.line ? localize('themeEditor.previewCommand', 'This preview supports help, clear and echo.') : '';
			this.data.fire('\r\n' + output + '\r\n$ ');
			this.line = '';
		} else if (data === '\x7f' && this.line) {
			this.line = this.line.slice(0, -1);
			this.data.fire('\b \b');
		} else if (/^[\x20-\x7e]+$/u.test(data) && this.line.length + data.length <= 1024) {
			this.line += data;
			this.data.fire(data);
		}
	}
	shutdown(): void { this.dispose(); }
}
const terminal = await services.get(ITerminalService).createTerminal({
	dimensions: { cols: 90, rows: 8 },
	config: { name: localize('themeEditor.previewOnly', 'Preview only'), customPtyImplementation: id => new PreviewTerminalProcess(id) },
});
services.get(ITerminalGroupService).createGroup(terminal);
await services.get(ITerminalGroupService).showPanel(false);

let terminalScreen: typeof terminal.xterm;
const publishContent = connectThemePreview(resources, services.get(IWorkbenchThemeService), services.get(IConfigurationService), () => {
	const editors = services.get(ICodeEditorService).listCodeEditors();
	const buffer = terminalScreen?.raw.buffer.active;
	const output = buffer ? Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n') : '';
	return editors.map(editor => `${editor.getModel()?.uri.path ?? ''}\n${editor.getModel()?.getValue() ?? ''}`).join('\n') + '\n' + output;
});
void terminal.xtermReadyPromise.then(xterm => {
	if (xterm && !resources.isDisposed) {
		terminalScreen = xterm;
		const listener = xterm.raw.onWriteParsed(publishContent);
		resources.add(toDisposable(() => listener.dispose()));
		publishContent();
	}
});
resources.add(editorService.onDidActiveEditorChange(publishContent));
const editorListeners = resources.add(new DisposableStore());
const bindEditors = (): void => {
	editorListeners.clear();
	for (const editor of services.get(ICodeEditorService).listCodeEditors()) editorListeners.add(editor.onDidChangeModelContent(publishContent));
};
resources.add(editorService.onDidVisibleEditorsChange(bindEditors));
bindEditors();
