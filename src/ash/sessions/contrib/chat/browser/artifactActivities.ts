import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { ArtifactActivitiesModel } from './artifactActivitiesModel.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { Automation, AutomationRunStatus, IAutomationBackendService } from '../../../../platform/automations/common/automation.js';

const statusLabels: Record<AutomationRunStatus, () => string> = {
	pending: () => localize('sessions.artifact.run.pending', 'Pending'),
	running: () => localize('sessions.artifact.run.running', 'Running'),
	needsInput: () => localize('sessions.artifact.run.needsInput', 'Needs input'),
	stopping: () => localize('sessions.artifact.run.stopping', 'Stopping'),
	completed: () => localize('sessions.artifact.run.completed', 'Completed'),
	failed: () => localize('sessions.artifact.run.failed', 'Failed'),
	stopped: () => localize('sessions.artifact.run.stopped', 'Stopped'),
	skipped: () => localize('sessions.artifact.run.skipped', 'Skipped'),
};

/** Reads activities from the automation that owns this artifact's follow-up runs. */
export class ArtifactActivities extends Disposable {
	private readonly model: ArtifactActivitiesModel;

	constructor(container: HTMLElement, backend: IAutomationBackendService) {
		super();
		this.model = this._register(new ArtifactActivitiesModel(backend));
		const document = container.ownerDocument;
		const element = h(document, 'details');
		const summary = h(document, 'summary');
		summary.textContent = localize('sessions.artifact.activities', 'Activities');
		const status = h(document, 'p');
		status.setAttribute('role', 'status');
		const list = h(document, 'ul');
		element.append(summary, status, list);
		container.append(element);
		this._register(addDisposableListener(element, 'toggle', () => this.model.setExpanded(element.open)));
		this._register(autorun(reader => {
			const state = this.model.state.read(reader);
			status.textContent = state.kind === 'loading'
				? localize('sessions.artifact.loadingActivities', 'Loading activities…')
				: state.kind === 'error'
					? localize('sessions.artifact.activityLoadFailed', 'Could not load activities. Collapse and reopen to retry.')
					: state.runs.length ? '' : localize('sessions.artifact.noActivities', 'No activities yet.');
			list.replaceChildren(...(state.kind === 'ready' ? state.runs.map(run => {
				const item = h(document, 'li');
				item.textContent = localize('sessions.artifact.activityEntry', '{0} · {1}', new Date(run.startedAt ?? run.scheduledAt).toLocaleString(), statusLabels[run.status]());
				return item;
			}) : []));
		}));
	}

	setPlan(plan: Automation | undefined): void {
		this.model.setPlan(plan);
	}
}
