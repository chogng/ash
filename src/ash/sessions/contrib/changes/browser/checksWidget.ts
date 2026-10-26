import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/checksWidget.css';
import { LoadingSkeleton } from '../../../browser/ui/loadingSkeleton.js';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { isCancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { GitHubError, GitHubErrorCode } from '../../../../platform/github/common/githubService.js';
import { PullRequestFollowUpWidget } from './pullRequestFollowUpWidget.js';
import { ChecksViewModel, checkDetailsText } from './checksViewModel.js';
import { getCheckStateLabel } from './checksActions.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';

/** A keyboard-accessible, collapsible list of the selected Session's CI checks. */
export class ChecksWidget extends Disposable {
	public readonly element: HTMLElement;
	private readonly header: Button;
	private readonly followUp: PullRequestFollowUpWidget;
	private readonly body: HTMLElement;
	private readonly entries = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
		@IOpenerService opener: IOpenerService,
		@INotificationService notifications: INotificationService,
		@IChangesViewService viewState: IChangesViewService,
		@ISessionsService sessions: ISessionsService,
	) {
		super();
		this.followUp = this._register(instantiation.createInstance(PullRequestFollowUpWidget, container));
		this.element = h(container.ownerDocument, 'section', { className: 'ash-sessions-checks' });
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.header = this._register(new Button(this.element, {
			...defaultButtonStyles,
			label: localize('sessions.changes.checks', 'Checks'),
			onClick: () => {
				const selected = sessions.activeSelection;
				if (selected) { viewState.setSectionCollapsed(new SessionChangesEditorInput(selected).resource, 'checks', !this.body.hidden); }
			},
		}));
		this.header.domNode.setAttribute('aria-expanded', 'true');
		this.body = h(container.ownerDocument, 'div', { className: 'ash-sessions-checks-body' });
		this.body.setAttribute('aria-live', 'polite');
		this.element.append(this.body);
		this._register(autorun(reader => {
			this.body.hidden = viewState.activeSessionSectionCollapseStateObs.read(reader).checks;
			this.header.domNode.setAttribute('aria-expanded', String(!this.body.hidden));
		}));
		const model = this._register(instantiation.createInstance(ChecksViewModel));
		this._register(autorun(reader => {
			const state = model.checksObs.read(reader);
			this.element.hidden = !state.loading && !state.error && !state.checks.length;
			this.element.setAttribute('aria-busy', String(state.loading));
			// Reconcile by identity so polling does not remove the focused check link.
			const signature = JSON.stringify(state.checks);
			if (state.checks.length && this.body.dataset.signature === signature && !state.error) {
				return;
			}
			this.entries.clear();
			this.body.replaceChildren();
			this.body.dataset.signature = signature;
			if (state.loading && !state.checks.length && !state.error) {
				const loading = this.entries.add(new LoadingSkeleton(this.body, localize('sessions.changes.checkLoading', 'Loading checks…'), 'list', 3));
				loading.setVisible(true);
			}
			if (state.error) {
				const message = h(container.ownerDocument, 'p');
				message.textContent = state.error ? localize('sessions.changes.checkError', 'Could not load checks: {0}', state.error) : localize('sessions.changes.checkLoading', 'Loading checks…');
				this.body.append(message);
			}
			const list = h(container.ownerDocument, 'ul');
			for (const entry of state.checks) {
				const { pullRequest, check } = entry;
				const row = h(container.ownerDocument, 'li');
				const label = localize('sessions.changes.checkLabel', '{0} · {1} · {2}', check.name, getCheckStateLabel(check), pullRequest);
				const link = h(container.ownerDocument, 'a');
				link.textContent = label;
				link.title = label;
				if (check.detailsUrl && /^https:\/\//i.test(check.detailsUrl)) {
					link.href = check.detailsUrl;
					this.entries.add(addDisposableListener(link, 'click', event => {
						event.preventDefault();
						void opener.open(check.detailsUrl!).catch(error => notifications.error(getErrorMessage(error)));
					}));
				}
				row.append(link);
				if (check.id > 0) {
					const actions = h(container.ownerDocument, 'div', { className: 'ash-sessions-check-actions' });
					actions.setAttribute('role', 'group');
					actions.setAttribute('aria-label', localize('sessions.changes.checkActions', '{0} actions', check.name));
					row.append(actions);
					const action = (label: string, invoke: () => Promise<void>, kind?: 'rerun' | 'fix'): Button => {
						const button = this.entries.add(new Button(actions, {
							...defaultButtonStyles, presentation: 'secondary', label, enabled: !kind || !model.retryBlocked(entry, kind), onClick: () => {
								if (kind && model.retryBlocked(entry, kind)) return;
								button.enabled = false;
								void invoke().catch(error => {
									if (isCancellationError(error) || !row.isConnected) return;
									const code = error instanceof GitHubError ? error.code : undefined;
									notifications.error(code === GitHubErrorCode.PermissionDenied
										? localize('sessions.changes.checkPermission', 'Your GitHub account does not have permission for this check operation.')
										: code === GitHubErrorCode.Conflict
											? localize('sessions.changes.checkChanged', 'The pull request or check changed. Refresh checks before trying again.')
											: code === GitHubErrorCode.SubmissionUncertain
												? localize('sessions.changes.checkUncertain', 'GitHub may have accepted the re-run. Check the full results before trying again.')
												: code ? localize('sessions.changes.checkActionFailed', 'Could not complete the check operation. Check your GitHub account and repository access.') : getErrorMessage(error));
								}).finally(() => { if (row.isConnected) button.enabled = !kind || !model.retryBlocked(entry, kind); });
							}
						}));
						if (kind) this.entries.add(autorun(reader => { button.enabled = !model.retryBlocked(entry, kind, reader); }));
						return button;
					};
					let output: HTMLElement | undefined;
					let loadedActions = false;
					action(localize('sessions.changes.checkDetails', 'Read annotations'), async () => {
						const details = await model.details(entry);
						if (!row.isConnected) return;
						if (!output) {
							output = h(container.ownerDocument, 'pre', { className: 'ash-sessions-check-output' });
							output.tabIndex = 0;
							output.setAttribute('role', 'region');
							output.setAttribute('aria-label', localize('sessions.changes.checkOutput', '{0} annotations', check.name));
							row.append(output);
						}
						output.textContent = checkDetailsText(details) || localize('sessions.changes.checkNoAnnotations', 'No annotations were reported.');
						if (details.actionsJob && check.status === 'completed' && !loadedActions) {
							loadedActions = true;
							action(localize('sessions.changes.checkLogs', 'Download logs'), async () => { const url = await model.log(entry); if (row.isConnected) await opener.open(url); });
							action(localize('sessions.changes.checkRerun', 'Re-run job'), () => model.rerun(entry), 'rerun');
						}
						output.focus();
					});
					if (check.status === 'completed' && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(check.conclusion ?? '')) {
						action(localize('sessions.changes.checkFix', 'Ask agent to fix CI'), () => model.fix(entry), 'fix');
					}
				}
				list.append(row);
			}
			this.body.append(list);
		}));
	}
	public getAccessibleContent(): string {
		return [this.followUp.element.textContent, this.element.textContent].filter(Boolean).join('\n');
	}

}
