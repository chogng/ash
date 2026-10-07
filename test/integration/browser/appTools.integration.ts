import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/app-server/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/app-server/test/common/testAppServerProtocol.js';
import type { AppHostOperation } from '../../../.build/protocol/typescript/index.js';
import { AppToolsHost } from '../../../src/ash/sessions/contrib/appTools/browser/appToolsHost.js';
import { AppServerAppToolsHost } from '../../../src/ash/sessions/services/appTools/browser/appServerAppToolsHost.js';
import { ISessionGroupsService, SessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { SessionsList } from '../../../src/ash/sessions/browser/parts/sidebar/sessionsList.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ITerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import type { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import type { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; }>();
	private nextId = 0;
	on(event: string, listener: (payload: unknown) => void): void { let listeners = this.listeners.get(event); if (!listeners) this.listeners.set(event, listeners = new Set()); listeners.add(listener); }
	off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { this.listeners.get(event)?.forEach(listener => listener(payload)); }
	send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { queueMicrotask(() => this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'app-tools', workspaceRoot: '/' })); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const message = JSON.parse((payload as { frame: string; }).frame);
		if (message.method === 'initialize') { queueMicrotask(() => this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: createTestInitializeResult() }) })); return; }
		const pending = this.pending.get(message.id);
		if (pending) { this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(JSON.parse(message.result.json)); }
	}
	cancelLast(): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: `host-${this.nextId}` } }) }); }
	call(operation: AppHostOperation): Promise<unknown> {
		const id = `host-${++this.nextId}`;
		return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, method: 'app/request', params: { sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1', operation } }) }); });
	}
}
const resources = new DisposableStore();
const colorThemes = { dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const themeId = new URL(location.href).searchParams.get('theme') as keyof typeof colorThemes | null;
const colorTheme = themeId && Object.hasOwn(colorThemes, themeId) ? colorThemes[themeId] : darkColorTheme;
const theme = resources.add(new TestThemeService(colorTheme));
resources.add(bindColorTheme(theme, document.documentElement));
const transport = new Transport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'app-tools', flushInterval: 0 }));
const groups = resources.add(new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService));
const changes = resources.add(new Emitter<void>());
const opened: unknown[] = [];
const openedUrls: string[] = [];
let releaseTerminal: (() => void) | undefined;
const closedTerminals: string[] = [];
const sessions = [1, 2].map(id => ({ sessionId: `session-${id}`, title: `Task ${id}`, status: 'active', chats: [{ threadId: `thread-${id}`, status: 'active', origin: { type: 'root' } }] }));
const management = { sessions, state: 'ready' } as unknown as ISessionsManagementService;
const view = { activeSelection: undefined, visibleSelections: [], onDidChange: changes.event, openNewSession: () => { }, openSession: (sessionId: string) => opened.push(sessionId) } as unknown as ISessionsService;
const container = document.createElement('main');
document.body.append(container);
resources.add(new SessionsList(container, management, view, 'Tasks', 'New task', { onDidChange: Event.None, getSessionPullRequests: () => [], initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } }, groups));
const services = resources.add(new InstantiationService());
services.registerInstance(IEditorService, { openEditor: async (...args: unknown[]) => { opened.push(args); } } as unknown as IEditorService);
services.registerInstance(IOpenerService, { open: async (resource: { toString(): string; }) => { openedUrls.push(resource.toString()); return true; } } as unknown as IOpenerService);
services.registerInstance(ITerminalService, { createTerminal: () => new Promise(resolve => { releaseTerminal = () => resolve({ id: 'terminal-1' }); }), setActiveInstance: () => { }, closeTerminal: async (terminal: { id: string; }) => { closedTerminals.push(terminal.id); } } as unknown as ITerminalService);
services.registerInstance(IViewsService, { openView: async () => { } } as unknown as IViewsService);
services.registerInstance(IChatSessionNavigationService, { openConversation: async (sessionId: string, threadId: string) => { opened.push({ sessionId, threadId }); } } as unknown as IChatSessionNavigationService);
services.registerInstance(ISessionGroupsService, groups);
services.registerInstance(IAccessibilityService, { onDidChangeReducedMotion: Event.None, isMotionReduced: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches } as unknown as IAccessibilityService);
const appTools = resources.add(new AppServerAppToolsHost(client, services.createInstance(AppToolsHost, document, undefined)));
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
declare global { interface Window { ashAppToolsIntegration: { call(operation: AppHostOperation): Promise<unknown>; readonly opened: unknown[]; readonly openedUrls: string[]; cancelLast(): void; releaseTerminal(): void; disposeHost(): void; readonly closedTerminals: string[]; readonly terminalPending: boolean; }; } }
window.ashAppToolsIntegration = { call: operation => transport.call(operation), opened, openedUrls, cancelLast: () => transport.cancelLast(), releaseTerminal: () => releaseTerminal?.(), disposeHost: () => appTools.dispose(), closedTerminals, get terminalPending() { return releaseTerminal !== undefined; } };
