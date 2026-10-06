import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILinkPresentationService, type ILinkPresentationWatcher } from '../../../../../platform/dataChannel/common/dataChannel.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { GitHubError, GitHubErrorCode, IGitHubService, type IGitHubService as GitHubService, type GitHubRepositoryInfo } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';
import { LinkPresentationService } from '../../../../services/dataChannel/browser/dataChannelService.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { GitHubLinkPresentationContribution } from '../../browser/githubLinkPresentation.contribution.js';

function setup(resources: DisposableStore, github: GitHubService): { services: InstantiationService; accounts: Emitter<AccountState>; links: LinkPresentationService; notifications: NotificationService; signIns: string[]; } {
	const services = resources.add(new InstantiationService());
	const accounts = resources.add(new Emitter<AccountState>());
	const notifications = resources.add(new NotificationService());
	const signIns: string[] = [];
	services.registerInstance(IGitHubService, github);
	services.registerInstance(IAccountService, { onDidChangeAccounts: accounts.event, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [] }), startLogin: async () => { throw new Error('Use connection service'); }, cancelLogin: async () => { }, logout: async () => { } });
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { signIns.push('github'); }, cancel: async () => { } });
	services.registerInstance(IOpenerService, { _serviceBrand: undefined, open: async () => true, registerOpener: () => Disposable.None, registerValidator: () => Disposable.None, registerExternalOpener: () => Disposable.None, registerExternalUriResolver: () => Disposable.None, setDefaultExternalOpener() { }, resolveExternalUri: async resource => ({ resolved: resource, dispose() { }, [Symbol.dispose]() { } }) });
	const links = resources.add(services.createInstance(LinkPresentationService));
	services.registerInstance(ILinkPresentationService, links);
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [GitHubLinkPresentationContribution.ID]));
	host.advance(WorkbenchPhase.BlockStartup);
	assert.equal(links.getLinkPresentationRule(URI.parse('https://github.com/team/repo')), undefined);
	host.advance(WorkbenchPhase.BlockRestore);
	return { services, accounts, links, notifications, signIns };
}

function settled(resources: DisposableStore, watcher: ILinkPresentationWatcher): Promise<void> {
	return new Promise(resolve => resources.add(autorun(reader => {
		if (watcher.presentation.read(reader)?.isLoading === false || watcher.presentation.read(reader)?.status?.kind === 'error') { resolve(); }
	})));
}

test('production contribution registers the four GitHub link kinds and prompts once for authentication', async () => {
	using resources = new DisposableStore();
	const { links, notifications, signIns } = setup(resources, { ...createDisconnectedGitHubService(), readRepository: async () => { throw new GitHubError(GitHubErrorCode.AuthenticationRequired); } });
	const kinds = ['https://github.com/team/repo', 'https://github.com/team/repo/issues/7', 'https://github.com/team/repo/pull/7', `https://github.com/team/repo/commit/${'a'.repeat(40)}`].map(value => links.getLinkPresentationRule(URI.parse(value))?.kind);
	assert.deepEqual(kinds, ['repository', 'issue', 'pullRequest', 'commit']);
	const uri = URI.parse('https://github.com/team/repo');
	const rule = links.getLinkPresentationRule(uri)!;
	const first = resources.add(links.createLinkPresentationWatcher(rule.id, uri)!);
	const second = resources.add(links.createLinkPresentationWatcher(rule.id, uri)!);
	await Promise.all([settled(resources, first), settled(resources, second)]);
	assert.equal(notifications.getNotifications().length, 1);
	await notifications.getNotifications()[0].actions![0].run();
	assert.deepEqual(signIns, ['github']);
	assert.equal(links.getLinkPresentationRule(URI.parse('https://enterprise.test/team/repo')), undefined);
});

test('changing accounts cancels old reads and rejects their late presentation', async () => {
	using resources = new DisposableStore();
	let release!: (value: GitHubRepositoryInfo) => void;
	let token!: CancellationToken;
	const { links, accounts } = setup(resources, {
		...createDisconnectedGitHubService(), readRepository: async (_repository, cancellation) => {
			token = cancellation!;
			return new Promise<GitHubRepositoryInfo>(resolve => { release = resolve; });
		}
	});
	const uri = URI.parse('https://github.com/team/repo');
	const watcher = resources.add(links.createLinkPresentationWatcher(links.getLinkPresentationRule(uri)!.id, uri)!);
	accounts.fire({ revision: 2n, accounts: [] });
	release({ fullName: 'Old private repository', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: true, allowAutoMerge: false });
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual({ canceled: token.isCancellationRequested, presentation: watcher.presentation.get() }, { canceled: true, presentation: { kind: 'repository', isLoading: true, tooltip: 'Loading GitHub details…' } });
});

test('unsafe numeric references produce an explicit error without starting backend work or interrupting rendering', async () => {
	using resources = new DisposableStore();
	const { links } = setup(resources, createDisconnectedGitHubService());
	const uri = URI.parse('https://github.com/team/repo/issues/9007199254740992');
	const watcher = resources.add(links.createLinkPresentationWatcher(links.getLinkPresentationRule(uri)!.id, uri)!);
	await settled(resources, watcher);
	assert.equal(watcher.presentation.get()?.status?.kind, 'error');
});
