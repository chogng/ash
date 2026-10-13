import './media/changesActions.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import { readLocalRepositories, type LocalRepository } from '../../../../workbench/contrib/github/common/localRepository.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

/** Runs optional Git provider commands against a captured Session repository. */
export class SessionSyncChangesActionViewItem extends Disposable {
	private readonly sync: Button;
	private readonly publish: Button;
	private readonly workingTree: Button;
	private readonly picker = this._register(new DisposableStore());
	private generation = 0;
	private owner: string | undefined;
	private running = false;
	private readonly status: HTMLElement;
	private statusRequest = 0;
	private statusOwner: string | undefined;
	private readonly statusRefresh = this._register(new RunOnceScheduler(() => { void this.refreshStatus(); }, 60_000));

	constructor(
		container: HTMLElement,
		@ISessionsService private readonly sessions: ISessionsService,
		@ICommandService private readonly commands: ICommandService,
		@IQuickInputService private readonly input: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const element = h(container.ownerDocument, 'div', { className: 'ash-sessions-changes-actions' });
		container.append(element);
		this._register(toDisposable(() => element.remove()));
		this.sync = this._register(new Button(element, { label: localize('sessions.changes.sync', 'Sync changes'), onClick: () => { void this.run('sync'); } }));
		this.publish = this._register(new Button(element, { label: localize('sessions.changes.publish', 'Publish branch'), onClick: () => { void this.run('git.publish'); } }));
		this.workingTree = this._register(new Button(element, { label: localize('sessions.changes.workingTree', 'Review working tree'), onClick: () => { void this.run('git.openChangesSource'); } }));
		this.status = h(container.ownerDocument, 'p', { className: 'ash-sessions-changes-repository-status' });
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		element.append(this.status);
		this._register(sessions.onDidChange(() => { this.update(); void this.refreshStatus(); }));
		this._register(CommandsRegistry.onDidChangeCommands(() => { this.update(); void this.refreshStatus(); }));
		this.update();
		void this.refreshStatus();
	}

	private async refreshStatus(): Promise<void> {
		this.statusRefresh.cancel();
		const request = ++this.statusRequest;
		const generation = this.generation;
		const selected = this.sessions.activeSelection;
		const workspace = selected?.kind === 'session' ? selected.active.session.workspace : undefined;
		if (this.statusOwner !== this.owner || !workspace || !CommandsRegistry.hasCommand('git.getRepositoryContexts')) {
			this.status.textContent = '';
			this.status.hidden = true;
			this.statusOwner = this.owner;
		}
		if (!workspace || !CommandsRegistry.hasCommand('git.getRepositoryContexts')) { return; }
		const root = workspace.authorityId === 'local' ? URI.file(workspace.root) : createSshRemoteWorkspaceUri(workspace.authorityId, workspace.root);
		const current = (): boolean => !this.isDisposed && request === this.statusRequest && generation === this.generation;
		try {
			const repositories = (await readLocalRepositories(this.commands)).filter(repository =>
				extUriBiasedIgnorePathCase.isEqualOrParent(repository.root, root) || extUriBiasedIgnorePathCase.isEqualOrParent(root, repository.root));
			if (!current()) { return; }
			this.status.textContent = repositories.map(repository => {
				const upstream = repository.head.upstream;
				return [
					`${repository.label}: ${repository.head.name || (repository.head.type === 'detached' ? localize('sessions.changes.detached', 'Detached HEAD') : localize('sessions.changes.noBranch', 'No branch'))}`,
					upstream ? localize('sessions.changes.trackingCounts', '{0}: {1} incoming · {2} outgoing', upstream.name, upstream.behind, upstream.ahead) : undefined,
					repository.uncommittedChanges === undefined ? undefined : repository.uncommittedChanges === 1
						? localize('sessions.changes.uncommittedOne', '1 uncommitted file')
						: localize('sessions.changes.uncommittedCount', '{0} uncommitted files', repository.uncommittedChanges),
				].filter(Boolean).join(' · ');
			}).join('\n');
			this.status.hidden = !this.status.textContent;
		} catch {
			if (current()) {
				this.status.textContent = localize('sessions.changes.repositoryStatusError', 'Repository status is unavailable.');
				this.status.hidden = false;
			}
		} finally {
			if (current()) { this.statusRefresh.schedule(); }
		}
	}

	private update(): void {
		const selected = this.sessions.activeSelection;
		const owner = selected?.kind === 'session' ? JSON.stringify([selected.active.session.sessionId, selected.active.threadId, selected.active.session.workspace]) : undefined;
		if (owner !== this.owner) { this.owner = owner; this.generation++; this.picker.clear(); }
		const hasWorkspace = selected?.kind === 'session' && !!selected.active.session.workspace;
		for (const [button, available] of [
			[this.sync, CommandsRegistry.hasCommand('git.pull') && CommandsRegistry.hasCommand('git.push')],
			[this.publish, CommandsRegistry.hasCommand('git.publish')],
			[this.workingTree, CommandsRegistry.hasCommand('git.openChangesSource')],
		] as const) {
			button.domNode.hidden = !hasWorkspace || !available || !CommandsRegistry.hasCommand('git.getRepositoryContexts');
			button.enabled = !this.running;
		}
	}

	private async choose(repositories: readonly LocalRepository[]): Promise<LocalRepository | undefined> {
		if (repositories.length === 1) { return repositories[0]; }
		if (!repositories.length) { throw new Error(localize('sessions.changes.noRepository', 'No Git repository is available in this session directory.')); }
		const picker = this.input.createQuickPick<{ label: string; description: string; repository: LocalRepository; }>();
		this.picker.add(picker);
		picker.items = repositories.map(repository => ({ label: repository.label, description: repository.path, repository }));
		picker.ariaLabel = picker.placeholder = localize('sessions.changes.chooseRepository', 'Choose a session repository');
		return new Promise(resolve => {
			let result: LocalRepository | undefined;
			this.picker.add(toDisposable(() => resolve(result)));
			this.picker.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				result = item.repository; picker.hide();
			}));
			this.picker.add(picker.onDidHide(() => this.picker.clear()));
			picker.show();
		});
	}

	private async run(command: 'sync' | 'git.publish' | 'git.openChangesSource'): Promise<void> {
		const selected = this.sessions.activeSelection;
		const workspace = selected?.kind === 'session' ? selected.active.session.workspace : undefined;
		if (!workspace || this.running) { return; }
		const generation = this.generation;
		const current = (): boolean => !this.isDisposed && generation === this.generation;
		const root = workspace.authorityId === 'local' ? URI.file(workspace.root) : createSshRemoteWorkspaceUri(workspace.authorityId, workspace.root);
		this.running = true;
		this.update();
		try {
			const repositories = (await readLocalRepositories(this.commands)).filter(repository =>
				extUriBiasedIgnorePathCase.isEqualOrParent(repository.root, root)
				|| extUriBiasedIgnorePathCase.isEqualOrParent(root, repository.root));
			if (!current()) { return; }
			const repository = await this.choose(repositories);
			if (!repository || !current()) { return; }
			const verify = async (): Promise<boolean> => {
				const fresh = (await readLocalRepositories(this.commands)).find(candidate => candidate.id === repository.id);
				if (!current()) { return false; }
				if (!fresh
					|| !extUriBiasedIgnorePathCase.isEqual(fresh.root, repository.root)
					|| fresh.head.type !== repository.head.type
					|| fresh.head.name !== repository.head.name
					|| JSON.stringify(fresh.remotes) !== JSON.stringify(repository.remotes)) {
					throw new Error(localize('sessions.changes.repositoryChanged', 'The repository or branch changed. Start the operation again.'));
				}
				return true;
			};
			if (!await verify()) { return; }
			if (command === 'sync') {
				await this.commands.executeCommand('git.pull', repository.id);
				if (!await verify()) { return; }
				await this.commands.executeCommand('git.push', repository.id);
				if (current()) { this.notifications.info(localize('sessions.changes.synced', 'Synchronized {0}.', repository.label)); }
			} else {
				await this.commands.executeCommand(command, repository.id, ...(command === 'git.openChangesSource' ? ['uncommitted'] : []));
			}
		} catch (error) {
			if (current()) { this.notifications.error(getErrorMessage(error)); }
		} finally {
			this.picker.clear();
			this.running = false;
			if (!this.isDisposed) { this.update(); void this.refreshStatus(); }
		}
	}
}
