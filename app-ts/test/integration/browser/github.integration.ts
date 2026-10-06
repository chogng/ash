import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { Event, Emitter } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IAccountService, type AccountState } from '../../../src/ash/platform/accounts/common/accountService.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/app-server/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/app-server/test/common/testAppServerProtocol.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { AccessibleViewType, AccessibilityVerbositySettingId } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js';
import { BrowserLayoutService, ILayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { AppServerGitHubService } from '../../../src/ash/platform/github/browser/appServerGitHubService.js';
import { IGitHubService } from '../../../src/ash/platform/github/common/githubService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { GitHubLinkPresentationContribution } from '../../../src/ash/workbench/contrib/github/browser/githubLinkPresentation.contribution.js';
import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListWidget.js';
import { IGitHubConnectionService } from '../../../src/ash/workbench/services/accounts/common/gitHubConnectionService.js';
import '../../../src/ash/workbench/services/dataChannel/browser/dataChannelService.js';

interface Request { readonly id: number; readonly method: string; readonly params: Record<string, unknown>; }
const sha = 'abcdef0123456789abcdef0123456789abcdef01';
class GitHubTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	public readonly requests: Request[] = [];
	private heldChecks: Request | undefined;
	private heldIssue: Request | undefined;
	public on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
		listeners.add(listener);
	}
	public off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(payload); } }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'github-test', workspaceRoot: '/workspace' });
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as Request;
		this.requests.push(request);
		switch (request.method) {
			case 'initialize': this.respond(request, createTestInitializeResult()); break;
			case 'github/repository/read': this.respond(request, { fullName: 'team/repo', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: true, allowAutoMerge: false }); break;
			case 'github/issue/read':
				if (request.params.number === 9) { this.heldIssue = request; }
				else { this.respond(request, { issue: { number: 7, url: 'https://github.com/team/repo/issues/7', title: '<img src=x onerror=alert(1)>', state: 'open', labels: [], assignees: [], updatedAt: '2026-10-04T12:00:00Z' }, body: `**Issue details** ${'Long description '.repeat(30)}`, comments: [] }); }
				break;
			case 'github/pullRequest/read': {
				const query = new URL(location.href).searchParams;
				const state = query.get('prState') ?? 'draft';
				this.respond(request, { number: 8, title: 'Fix GitHub links', body: 'Pull request details', url: 'https://github.com/team/repo/pull/8', state: state === 'merged' || state === 'closed' ? 'closed' : 'open', draft: state === 'draft', mergedAt: state === 'merged' ? '2026-10-06T00:00:00Z' : null, headCommit: sha, headBranch: 'feature/links', headRepository: query.has('deletedSource') ? null : 'contributor/fork', baseBranch: 'main', mergeable: null, autoMerge: false });
				break;
			}
			case 'github/checks': this.heldChecks = request; break;
			case 'github/commit/read': this.respond(request, { sha, url: `https://github.com/team/repo/commit/${sha}`, message: 'Improve links\n\nCommit description', author: 'Alex', committedAt: '2026-10-04T12:00:00Z', additions: 12, deletions: 3 }); break;
			case 'github/cancel': this.respond(request, { status: 'requested' }); break;
			default: throw new Error(`Unexpected GitHub request: ${request.method}`);
		}
	}
	private respond(request: Request, result: unknown): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }); }
	public releaseChecks(outcome: 'success' | 'failure' | 'mixed' = 'success'): void {
		if (!this.heldChecks) { throw new Error('No pending checks'); }
		this.respond(this.heldChecks, { state: outcome === 'success' ? 'success' : 'failure', statuses: outcome === 'mixed' ? [{ state: 'pending', context: 'build', description: null, targetUrl: null }] : [], checks: [{ id: 1, name: 'tests', status: 'completed', conclusion: outcome === 'success' ? 'success' : 'failure', detailsUrl: null }], nextPage: null });
		this.heldChecks = undefined;
	}
	public releaseIssue(): void {
		if (!this.heldIssue) { throw new Error('No pending issue'); }
		this.respond(this.heldIssue, { issue: { number: 9, url: 'https://github.com/team/repo/issues/9', title: 'Old private issue', state: 'closed', labels: [], assignees: [], updatedAt: '2026-10-04T12:00:00Z' }, body: 'Old private body', comments: [] });
		this.heldIssue = undefined;
	}
}

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
registerCodeEditorServices(services);
const transport = new GitHubTransport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
services.registerInstance(IGitHubService, new AppServerGitHubService(client));
const accounts = resources.add(new Emitter<AccountState>());
services.registerInstance(IAccountService, { onDidChangeAccounts: accounts.event, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [] }), startLogin: async () => { throw new Error('Use GitHub connection'); }, cancelLogin: async () => { }, logout: async () => { } });
services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { }, cancel: async () => { } });
const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [GitHubLinkPresentationContribution.ID]));
host.advance(WorkbenchPhase.BlockRestore);
resources.add(bindColorTheme(theme, document.body));
const opener = services.get(IOpenerService);
const opened: string[] = [];
opener.setDefaultExternalOpener({ openExternal: async href => { opened.push(href); return true; } });
const container = document.createElement('main');
document.body.append(container);
services.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: container })));
const widget = resources.add(services.createInstance(ChatListWidget, container, { onDidRequestLink: (target: string) => { void opener.open(target, { openExternal: true, fromUserGesture: true }); } }));
widget.setVisible(true);
const render = (text: string): void => widget.render([{ id: 'message', type: 'agentMessage', text, transient: false }]);
render(`[Repo](https://github.com/team/repo) [Issue](https://github.com/team/repo/issues/7) [PR](https://github.com/team/repo/pull/8) [Commit](https://github.com/team/repo/commit/${sha})`);
window.ashGitHubIntegration = {
	requests: transport.requests, opened, releaseChecks: outcome => transport.releaseChecks(outcome), releaseIssue: () => transport.releaseIssue(),
	render, replaceAccount: () => accounts.fire({ revision: 2n, accounts: [] }),
	theme: name => theme.setColorTheme(name === 'light' ? lightColorTheme : highContrastDarkColorTheme),
	setVerbosity: value => services.get(IConfigurationService).updateValue(AccessibilityVerbositySettingId.GitHub, value),
	accessibleContent: type => {
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name === `github.${type}`)!;
		return implementation.getProvider(services)!.provideContent();
	},
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
declare global {
	interface Window {
		ashGitHubIntegration: { requests: Request[]; opened: string[]; releaseChecks(outcome?: 'success' | 'failure' | 'mixed'): void; releaseIssue(): void; render(text: string): void; replaceAccount(): void; theme(name: 'light' | 'highContrast'): void; setVerbosity(value: boolean): Promise<void>; accessibleContent(type: AccessibleViewType): string; dispose(): void; };
	}
}
