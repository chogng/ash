import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ChecksWidget } from '../../github/browser/checksWidget.js';
import { CreatePullRequestRailAction } from '../../github/browser/createPullRequestContextView.js';
import { ISessionGitActionsService } from '../../../services/sessions/browser/sessionGitActionsService.js';

/** Composes repository actions and PR checks for the visible Code conversation. */
export class SessionEnvironmentActions extends Disposable {
	private readonly branchActions: HTMLSelectElement;
	private readonly sync: HTMLOptionElement;
	private readonly publish: HTMLOptionElement;
	private readonly status: HTMLParagraphElement;
	private readonly checksHost: HTMLElement;
	private readonly checks = this._register(new MutableDisposable<ChecksWidget>());
	private readonly pullRequest: CreatePullRequestRailAction;
	private readonly statusRefresh = this._register(new RunOnceScheduler(() => { void this.refreshStatus(); }, 60_000));
	private statusRequest = 0;
	private statusRoot: string | undefined;
	private visible = false;

	constructor(
		container: HTMLElement,
		private readonly model: Pick<ChatWidgetModel, 'selectedSession' | 'onDidChange'>,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionGitActionsService private readonly git: ISessionGitActionsService,
	) {
		super();
		const document = container.ownerDocument;
		const actions = h(document, 'div', { className: 'ash-session-environment-git-actions' });
		container.append(actions);
		const label = localize('sessions.changes.branchActions', 'Git branch actions');
		this.branchActions = h(document, 'select');
		this.branchActions.setAttribute('aria-label', label);
		const placeholder = this.addOption('', label);
		placeholder.disabled = true;
		this.sync = this.addOption('sync', localize('sessions.changes.sync', 'Sync changes'));
		this.publish = this.addOption('publish', localize('sessions.changes.publish', 'Publish branch'));
		this.branchActions.value = '';
		actions.append(this.branchActions);
		this._register(addDisposableListener(this.branchActions, 'change', () => {
			const action = this.branchActions.value;
			this.branchActions.value = '';
			if (!this.ownsSelection) { return; }
			if (action === 'sync' || action === 'publish') { void git.run(action === 'sync' ? 'sync' : 'git.publish'); }
		}));
		this.pullRequest = this._register(instantiation.createInstance(CreatePullRequestRailAction, actions, model));
		this.status = h(document, 'p', { className: 'ash-session-environment-repository-status' });
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		this.checksHost = h(document, 'div');
		container.append(this.status, this.checksHost);
		this._register(git.onDidChange(() => this.update(true)));
		this._register(model.onDidChange(() => this.update()));
		this._register(sessions.onDidChange(() => this.update()));
		this.update();
	}

	private addOption(value: string, label: string): HTMLOptionElement {
		const option = h(this.branchActions.ownerDocument, 'option');
		option.value = value;
		option.textContent = label;
		this.branchActions.append(option);
		return option;
	}

	private get ownsSelection(): boolean {
		const target = this.model.selectedSession;
		const active = this.sessions.activeSelection;
		return target.kind === 'session' && active?.kind === 'session'
			&& target.active.session.sessionId === active.active.session.sessionId && target.active.threadId === active.active.threadId;
	}

	get hasOpenPopup(): boolean { return this.pullRequest.hasOpenPopup || this.git.hasOpenPicker; }

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (!visible) { this.pullRequest.closePopup(); }
		this.update();
	}

	getAccessibleHelp(): string {
		return localize('sessions.info.checksHelp', 'Checks shows the check runs and commit statuses for associated open pull requests. Press Enter or Space to expand or collapse Checks. Check links open the full results.') + '\n' + localize('sessions.changes.ciActionsHelp', 'For a failed check, Read annotations shows plain text output and file locations. GitHub Actions checks also offer Download logs and Re-run job after annotations load. Ask agent to fix CI explicitly sends the displayed check and captured PR head to the initiating conversation, or queues it behind an active Turn, using normal permissions. No request is sent while reading checks. A changed session, account or PR head invalidates old operations; an uncertain submission must be checked before retrying.') + '\n' + localize('sessions.changes.followUpHelp', 'Follow PR checks starts background CI observation for the displayed PR and this conversation. It requests one repair per commit after all checks finish. Stop PR follow-up pauses observation and stops its current repair. Follow-up history opens Routines to inspect runs and their conversations. Follow-up continues after the window closes; account changes require enabling it again.');
	}

	getAccessibleContent(): string {
		return [this.status.textContent, this.checks.value?.getAccessibleContent()].filter(Boolean).join('\n');
	}

	private update(refreshStatus = false): void {
		const active = this.visible && this.ownsSelection;
		this.sync.hidden = this.sync.disabled = !this.git.canSync;
		this.publish.hidden = this.publish.disabled = !this.git.canPublish;
		this.branchActions.hidden = !active || (this.sync.hidden && this.publish.hidden);
		this.branchActions.disabled = this.git.busy;
		if (!active) { this.checks.clear(); }
		else if (!this.checks.value) { this.checks.value = this.instantiation.createInstance(ChecksWidget, this.checksHost); }
		const root = active ? this.git.repositoryRoot?.toString() : undefined;
		if (refreshStatus || this.statusRoot !== root) { void this.refreshStatus(); }
	}

	private async refreshStatus(): Promise<void> {
		this.statusRefresh.cancel();
		const request = ++this.statusRequest;
		const root = this.visible && this.ownsSelection ? this.git.repositoryRoot : undefined;
		const key = root?.toString();
		if (!root || this.statusRoot !== key) {
			this.status.textContent = '';
			this.status.hidden = true;
			this.statusRoot = key;
		}
		if (!root) { return; }
		const current = (): boolean => !this.isDisposed && request === this.statusRequest;
		try {
			const repositories = await this.git.readRepositories(root);
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
}
