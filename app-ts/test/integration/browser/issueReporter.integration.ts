import type { IEditorPane } from '../../../src/ash/workbench/common/editor.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import messages from '../../../localization/zh-CN/workbench.json' with { type: 'json' };
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IAccountService, type AccountState } from '../../../src/ash/platform/accounts/common/accountService.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/app-server/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/app-server/test/common/testAppServerProtocol.js';
import { AppServerIssueReporterService } from '../../../src/ash/platform/issue/browser/appServerIssueReporterService.js';
import { AppServerGitHubService } from '../../../src/ash/platform/github/browser/appServerGitHubService.js';
import { IGitHubService } from '../../../src/ash/platform/github/common/githubService.js';
import { IIssueReporterService } from '../../../src/ash/platform/issue/common/issue.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, highContrastDarkColorTheme, lightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IGitHubConnectionService } from '../../../src/ash/workbench/services/accounts/common/gitHubConnectionService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';

import '../../../src/ash/workbench/contrib/issue/browser/issue.contribution.js';

interface Request { id: number; method: string; params: Record<string, unknown>; }
interface AccountMetadata { id: string; host: string; login: string; status: 'ready'; credentialRevision: string; }
class ReporterTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly requests: Request[] = [];
	accountCatalog: AccountMetadata[] = [];
	private heldSearch: Request | undefined;
	private heldSubmit: Request | undefined;
	holdSearch = false;
	holdSubmit = false;
	failure: string | undefined;
	signedIn = false;
	on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event); if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); } listeners.add(listener);
	}
	off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
	send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'issue-test', workspaceRoot: '/workspace' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as Request;
		this.requests.push(request);
		switch (request.method) {
			case 'initialize': {
				const result = createTestInitializeResult(); result.capabilities.contracts.issueReporter = { version: 1 }; this.respond(request, result); break;
			}
			case 'issueReporter/read': this.respond(request, { reportIssueUrl: 'https://github.com/chogng/ash/issues', version: '0.1.0-test', os: 'windows', arch: 'x86_64' }); break;
			case 'github/account/list': this.respond(request, { accounts: this.accountCatalog }); break;
			case 'issueReporter/search':
				if (this.holdSearch) { this.heldSearch = request; } else { this.respond(request, { issues: [{ number: 7, url: 'https://github.com/chogng/ash/issues/7', title: 'Existing editor bug', state: 'open' }] }); }
				break;
			case 'issueReporter/search/cancel':
				if (this.heldSearch) { this.reject(this.heldSearch, 'RequestCancelled'); this.heldSearch = undefined; }
				this.respond(request, { status: 'requested' }); break;
			case 'issueReporter/submit':
				if (!this.signedIn) { this.reject(request, 'AccountAuthenticationRequired'); }
				else if (this.failure) { this.reject(request, this.failure); }
				else if (this.holdSubmit) { this.heldSubmit = request; }
				else { this.finishSubmit(request); }
				break;
			default: throw new Error(`Unexpected reporter request: ${request.method}`);
		}
	}
	private respond(request: Request, result: unknown): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }); }
	private reject(request: Request, kind: string): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32070, message: kind, data: { kind } } }) }); }
	private finishSubmit(request: Request): void { this.respond(request, { number: 8, url: 'https://github.com/chogng/ash/issues/8', title: request.params.title, state: 'open' }); }
	releaseSubmit(): void { if (!this.heldSubmit) { throw new Error('No held submission'); } this.finishSubmit(this.heldSubmit); this.heldSubmit = undefined; }
}

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') { setNlsMessages('zh-CN', messages); }
const resources = new DisposableStore();
const services = resources.add(new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors())));
const transport = new ReporterTransport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
const backend = new AppServerIssueReporterService(client);
services.registerInstance(IExtensionService, {
	currentCatalog: { generation: 1, extensions: [{ id: 'example.syntax', name: 'syntax', publisher: 'example', version: '1.2.3', displayName: 'Syntax', sourceKind: 'builtIn', manifestSha256: 'a'.repeat(64), packageSha256: 'b'.repeat(64) }], diagnostics: new URL(location.href).searchParams.has('extensionsFailed') ? [{ code: 'sourceUnavailable', message: 'Extension source is unavailable.', source: 'user', subject: undefined }] : [] },
	onDidChange: Event.None, onDidFail: Event.None, start: async () => { }, reload: async () => { },
} as unknown as IExtensionService);
services.registerInstance(IIssueReporterService, backend);
services.registerInstance(IGitHubService, new AppServerGitHubService(client));
const accounts = resources.add(new Emitter<AccountState>());
const accountState = (): AccountState => ({ revision: 1n, accounts: transport.signedIn ? [{ provider: 'github', accountId: '42', displayName: 'Test account', status: 'ready', credentialRevision: 1n }] : [] });
let releaseAccountRead: (() => void) | undefined;
services.registerInstance(IAccountService, {
	onDidChangeAccounts: accounts.event, onDidCompleteLogin: Event.None, read: async () => {
		const snapshot = accountState();
		if (new URL(location.href).searchParams.has('holdAccountRead')) { await new Promise<void>(resolve => { releaseAccountRead = resolve; }); }
		return snapshot;
	}, startLogin: async () => { throw new Error('Use GitHub connection'); }, cancelLogin: async () => { }, logout: async () => { transport.signedIn = false; accounts.fire(accountState()); }
});
services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { transport.signedIn = true; transport.accountCatalog = [{ id: '42', host: 'github.com', login: 'Test account', status: 'ready', credentialRevision: '1' }]; accounts.fire(accountState()); }, cancel: async () => { } });
services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
const opened: string[] = [];
services.registerInstance(IOpenerService, { open: async target => { opened.push(String(target)); return true; } } as IOpenerService);
let pane: IEditorPane | undefined;
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [],
	openEditor: async input => {
		if (pane) { pane.dispose(); }
		const descriptor = EditorPanes.getEditorPane(input)!;
		const createdPane = descriptor.create({ instantiationService: services });
		pane = createdPane;
		createdPane.create(document.getElementById('reporter')!);
		createdPane.layout({ width: innerWidth, height: innerHeight }); await createdPane.setInput(input, new AbortController().signal); createdPane.focus();
	},
	focusActiveEditor: () => pane!.focus(),
});
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(theme, document.body));
const commands = resources.add(new CommandService(services));
window.ashIssueReporterIntegration = {
	requests: transport.requests, opened,
	open: () => commands.executeCommand('workbench.action.openIssueReporter'),
	close: () => { pane?.dispose(); pane = undefined; },
	holdSearch: () => { transport.holdSearch = true; },
	holdSubmit: () => { transport.holdSubmit = true; },
	releaseSubmit: () => transport.releaseSubmit(),
	releaseAccountRead: () => releaseAccountRead!(),
	setAccounts: catalog => { transport.accountCatalog = catalog; accounts.fire(accountState()); },
	fail: kind => { transport.failure = kind; },
	theme: name => theme.setColorTheme(name === 'light' ? lightColorTheme : highContrastDarkColorTheme),
	dispose: () => { pane?.dispose(); resources.dispose(); },
};
declare global {
	interface Window {
		ashIssueReporterIntegration: {
			requests: Request[]; opened: string[]; open(): Promise<void>; close(): void; holdSearch(): void; holdSubmit(): void; releaseSubmit(): void; releaseAccountRead(): void; setAccounts(catalog: AccountMetadata[]): void; fail(kind: string): void; theme(name: 'light' | 'highContrast'): void; dispose(): void;
		};
	}
}
