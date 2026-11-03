import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { Automation, AutomationRun, IAutomationBackendService } from '../../../../platform/automations/common/automation.js';

type ActivitiesState =
	| { readonly kind: 'loading'; }
	| { readonly kind: 'error'; }
	| { readonly kind: 'ready'; readonly runs: readonly AutomationRun[]; };

/** Projects persisted runs for one artifact without keeping a second run history. */
export class ArtifactActivitiesModel extends Disposable {
	readonly state = observableValue<ActivitiesState>(this, { kind: 'ready', runs: [] });
	private revision = 0;
	private plan: Automation | undefined;
	private expanded = false;

	constructor(private readonly backend: IAutomationBackendService) {
		super();
		this._register(backend.onDidChange(() => this.refresh()));
	}

	setPlan(plan: Automation | undefined): void {
		if (this.plan?.id === plan?.id && this.plan?.revision === plan?.revision) return;
		this.plan = plan;
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.refresh();
	}

	private refresh(): void {
		const revision = ++this.revision;
		const plan = this.plan;
		if (!this.expanded || !plan) {
			this.state.set({ kind: 'ready', runs: [] });
			return;
		}
		this.state.set({ kind: 'loading' });
		void this.backend.runs(plan.id).then(runs => {
			if (!this.isDisposed && revision === this.revision) this.state.set({ kind: 'ready', runs });
		}, () => {
			if (!this.isDisposed && revision === this.revision) this.state.set({ kind: 'error' });
		});
	}
}
