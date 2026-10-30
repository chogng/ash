import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IPolicyService, PolicyValueSource } from '../../../../platform/policy/common/policy.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

type CountBucket = '0' | '1' | '2-5' | '6-20' | '21+';
type SourceCount = { source: PolicyValueSource | 'unknown'; countBucket: CountBucket; };
type SourceCountClassification = {
	owner: 'chogng';
	comment: 'Effective policy source counts, without policy names, values or account identity.';
	source: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Category of the effective policy source, to diagnose source precedence.'; };
	countBucket: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Bucketed count of applied policies for this source, to diagnose missing policy delivery.'; };
};

/** Uses the host's existing telemetry service and collection policy. */
export class PolicyTelemetryContribution extends Disposable {
	constructor(
		@IPolicyService private readonly policies: IPolicyService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
	) {
		super();
		const report = this._register(new RunOnceScheduler(() => this.report(), 500));
		this._register(policies.onDidChange(() => report.schedule()));
		report.schedule();
	}

	private report(): void {
		const counts = new Map<SourceCount['source'], number>([...Object.values(PolicyValueSource), 'unknown' as const].map(source => [source, 0]));
		for (const [name, entry] of Object.entries(this.policies.serialize() ?? {})) {
			if (entry.value === undefined) continue;
			const source = this.policies.getPolicyValueSource(name) ?? 'unknown';
			counts.set(source, counts.get(source)! + 1);
		}
		for (const [source, count] of counts) {
			const countBucket: CountBucket = count === 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : count <= 20 ? '6-20' : '21+';
			this.telemetry.publicLog2<SourceCount, SourceCountClassification>('policySourceCounts', { source, countBucket });
		}
	}
}

registerWorkbenchContribution('workbench.contrib.policyTelemetry', WorkbenchPhase.Eventually, accessor => accessor.get(IInstantiationService).createInstance(PolicyTelemetryContribution));
