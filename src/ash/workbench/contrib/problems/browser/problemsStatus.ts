import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { type IMarkerService } from '../../../../platform/markers/common/markers.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import {
	StatusbarAlignment,
	type IStatusbarEntry,
	type IStatusbarEntryAccessor,
	type IStatusbarService,
} from '../../../services/statusbar/browser/statusbar.js';
import type { IViewsService } from '../../../services/views/common/viewsService.js';

const ProblemsPriority = 700;

export interface ProblemsStatusContributionOptions {
	readonly statusbarService: IStatusbarService;
	readonly markerService: IMarkerService;
	readonly viewsService: IViewsService;
}

/** Projects workspace error and warning counts into the status bar. */
export class ProblemsStatusContribution extends Disposable implements IWorkbenchContribution {
	private readonly status: IStatusbarEntryAccessor;

	constructor(private readonly options: ProblemsStatusContributionOptions) {
		super();
		this.status = this._register(
			options.statusbarService.addEntry(this.entry(), {
				id: 'ash.status.problems',
				alignment: StatusbarAlignment.Left,
				priority: ProblemsPriority,
			}),
		);
		this._register(options.markerService.onMarkerChanged(() => this.update()));
	}

	private update(): void {
		this.status.update(this.entry());
	}

	private entry(): IStatusbarEntry {
		const { errors, warnings } = this.options.markerService.getStatistics();
		const summaries: string[] = [];
		if (errors > 0) summaries.push(localize('problems.errorCount', 'Errors: {0}', errors));
		if (warnings > 0) summaries.push(localize('problems.warningCount', 'Warnings: {0}', warnings));
		const tooltip =
			summaries.length === 0
				? localize('problems.noProblems', 'No Problems')
				: summaries.length === 1
					? summaries[0]!
					: localize('problems.summary', '{0}, {1}', summaries[0]!, summaries[1]!);
		return {
			text: '',
			segments: [
				{ icon: Lxicon.error, text: packNumber(errors) },
				{ icon: Lxicon.warning, text: packNumber(warnings) },
			],
			ariaLabel: tooltip,
			tooltip,
			run: () => this.options.viewsService.focusView('ash.problems'),
		};
	}
}

function packNumber(count: number): string {
	if (count > 9_999) return '10K+';
	if (count > 999) return `${String(count)[0]}K`;
	return String(count);
}
