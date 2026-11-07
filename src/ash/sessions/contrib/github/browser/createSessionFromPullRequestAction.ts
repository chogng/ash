import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { readLocalRepositories } from '../../../../workbench/contrib/github/common/localRepository.js';
import { getPullRequestContext } from '../../../../workbench/contrib/sessions/browser/github/fetchers/githubPullRequestContextFetcher.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensionService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { pickPullRequest, pickPullRequestRepository } from './pullRequestPicker.js';
import { createAndOpenPullRequestSession } from './pullRequestSessionCreation.js';

const when = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), SessionsWorkspaceModeContext.isEqualTo('code'));
const title = localize2({ bundle: 'ash.sessions', key: 'sessions.github.newFromPullRequest' }, 'New Session from Pull Request');

registerAction2(class NewSessionFromPullRequestAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.newSessionFromPullRequest', title, f1: true, precondition: when,
			menu: { id: Menus.SessionsViewFilter, when, group: 'create' },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commands = accessor.get(ICommandService);
		const extensions = accessor.get(IExtensionService);
		const quickInput = accessor.get(IQuickInputService);
		const management = accessor.get(ISessionsManagementService);
		const sessions = accessor.get(ISessionsService);
		const scopes = accessor.get(ISessionProviderScopeService);
		const progress = accessor.get(IProgressService);
		const notifications = accessor.get(INotificationService);
		const storage = accessor.get(IStorageService);
		const scope = scopes.getScope();
		const workspace = accessor.get(ISessionsProvidersService).getProvider(scope.providerId)?.currentWorkspace();
		if (workspace?.type === 'ssh' || workspace?.type === 'remote' || workspace?.type === 'provider') {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.localPullRequestWorkspace' }, 'Select a local execution host to create a session from a pull request.'));
		}
		const github = scope.services.host.github;
		const navigationRevision = sessions.navigationRevision;
		const [checkouts, accounts] = await Promise.all([
			extensions.activateByEvent('onCommand:git.getRepositoryContexts').then(() => readLocalRepositories(commands)),
			github.listAccounts(),
		]);
		scope.assertCurrent();
		const picker = new AbortController();
		const repositoryChoice = await pickPullRequestRepository(quickInput, checkouts, accounts, picker.signal);
		if (!repositoryChoice) return;
		const repository = repositoryChoice.repository;
		const number = await pickPullRequest(quickInput, github, repository, picker.signal);
		if (number === undefined) return;

		using cancellation = new CancellationTokenSource();
		const snapshot = await progress.withProgress({
			location: ProgressLocation.Notification,
			title: localize({ bundle: 'ash.sessions', key: 'sessions.github.fetchingPullRequest' }, 'Reading pull request #{0}…', number), cancellable: true,
		}, () => getPullRequestContext(github, repository, number, cancellation.token), () => cancellation.cancel()).catch(error => {
			if (!cancellation.token.isCancellationRequested) throw error;
			return undefined;
		});
		if (!snapshot || cancellation.token.isCancellationRequested) return;
		scope.assertCurrent();
		const account = accounts.find(account => account.id === repository.accountId);
		const current = (await github.listAccounts()).find(candidate => candidate.id === repository.accountId);
		if (current?.status !== 'ready' || current.credentialRevision !== account?.credentialRevision) {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestAccountChanged' }, 'The GitHub account changed while reading the pull request. Start again with the current account.'));
		}
		scope.assertCurrent();

		await createAndOpenPullRequestSession(management, sessions, progress, storage, {
			root: repositoryChoice.root,
			remote: repositoryChoice.remote,
			repository,
			number,
			snapshot,
			providerId: scope.providerId,
			navigationRevision,
		});

		const ready = localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestSessionReady' }, 'Session ready. Pull request #{0} is checked out and attached.', number);
		notifications.status(ready);
		status(ready);
	}
});
