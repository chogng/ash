import './media/checksWidget.css';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { ChecksViewModel } from './checksViewModel.js';
import { getCheckStateLabel } from './checksActions.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';

/** A keyboard-accessible, collapsible list of the selected Session's CI checks. */
export class ChecksWidget extends Disposable {
	public readonly element: HTMLElement;
	private readonly header: Button;
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
		this.element = h(container.ownerDocument, 'section', { className: 'ash-sessions-checks' });
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.header = this._register(new Button(this.element, {
			label: localize('sessions.changes.checks', 'Checks'), onClick: () => {
				const selected = sessions.activeSelection;
				if (selected) { viewState.setSectionCollapsed(new SessionChangesEditorInput(selected).resource, 'checks', !this.body.hidden); }
			}
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
			if (state.loading && !state.checks.length || state.error) {
				const message = h(container.ownerDocument, 'p');
				message.textContent = state.error ? localize('sessions.changes.checkError', 'Could not load checks: {0}', state.error) : localize('sessions.changes.checkLoading', 'Loading checks…');
				this.body.append(message);
			}
			const list = h(container.ownerDocument, 'ul');
			for (const { pullRequest, check } of state.checks) {
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
				list.append(row);
			}
			this.body.append(list);
		}));
	}
}
