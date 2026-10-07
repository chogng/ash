import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IGitHubService, type GitHubRepositoryInfo } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { GitHubReviewModel, IGitHubReviewModel } from '../../browser/githubReviewModel.js';
import { GitHubSettingsModel } from '../../browser/githubSettingsModel.js';

for (const lifecycle of ['hide', 'dispose'] as const) {
	test(`GitHub settings ${lifecycle} cancels the repository check and rejects its late result`, async () => {
		using resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		let token: CancellationToken | undefined;
		let release!: (repository: GitHubRepositoryInfo) => void;
		services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [{ provider: 'github', accountId: 'alice', status: 'ready', credentialRevision: 1n }] }), startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async () => { } });
		services.registerInstance(IGitHubService, {
			listAccounts: async () => [{ id: 'alice', host: 'github.com', login: 'alice', status: 'ready', credentialRevision: 1n }],
			readRepository: async (_repository, cancellation) => { token = cancellation; return new Promise(resolve => { release = resolve; }); },
		} as Partial<IGitHubService> as IGitHubService);
		services.registerInstance(IGitHubReviewModel, resources.add(services.createInstance(GitHubReviewModel)));
		services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { }, cancel: async () => { } });
		services.registerInstance(IEditorService, {} as IEditorService);
		services.registerInstance(IOpenerService, {} as IOpenerService);
		services.registerInstance(IRemoteAgentService, { connectionState: 'connected', connection: { kind: 'local', generation: 1 }, onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
		const model = resources.add(services.createInstance(GitHubSettingsModel, async () => { }));
		const ready = new Promise<void>(resolve => {
			const listener = resources.add(model.onDidChange(() => {
				if (model.fields.some(field => field.id === 'check' && field.kind === 'action' && field.enabled)) { listener.dispose(); resolve(); }
			}));
		});
		model.setVisible(true); await ready;
		const repository = model.fields.find(field => field.id === 'repository'); assert.ok(repository?.kind === 'text'); repository.setValue('team/private');
		const check = model.fields.find(field => field.id === 'check'); assert.ok(check?.kind === 'action');
		const pending = check.run();
		if (lifecycle === 'hide') { model.setVisible(false); } else { model.dispose(); }
		assert.equal(token?.isCancellationRequested, true);
		release({ fullName: 'team/private', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: true, allowAutoMerge: false });
		await pending;
		assert.ok(model.fields.some(field => field.id === 'browse' && field.kind === 'action' && !field.enabled));
	});
}
