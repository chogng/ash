import { Disposable } from "../../../../base/common/lifecycle.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { MarkerSeverity, type IMarkerService } from "../../../../platform/markers/common/markers.js";
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import type { IViewsService } from "../../../services/views/browser/viewsService.js";

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
		this.status = this._register(options.statusbarService.addEntry(this.entry(), {
			id: "ash.status.problems",
			alignment: StatusbarAlignment.Left,
			priority: ProblemsPriority,
		}));
		this._register(options.markerService.onDidChange(() => this.update()));
	}

	private update(): void {
		this.status.update(this.entry());
	}

	private entry(): IStatusbarEntry {
		const errors = this.count(MarkerSeverity.Error);
		const warnings = this.count(MarkerSeverity.Warning);
		const summaries: string[] = [];
		if (errors > 0) summaries.push(`Errors: ${errors}`);
		if (warnings > 0) summaries.push(`Warnings: ${warnings}`);
		const tooltip = summaries.length === 0 ? "No Problems" : summaries.join(", ");
		return {
			text: "",
			segments: [
				{ icon: lxiconsLibrary.error, text: packNumber(errors) },
				{ icon: lxiconsLibrary.warning, text: packNumber(warnings) },
			],
			ariaLabel: tooltip,
			tooltip,
			run: () => this.options.viewsService.focusView("ash.problems"),
		};
	}

	private count(severity: MarkerSeverity): number {
		return this.options.markerService.getAll().filter(marker => marker.severity === severity).length;
	}
}

function packNumber(count: number): string {
	if (count > 9_999) return "10K+";
	if (count > 999) return `${String(count)[0]}K`;
	return String(count);
}
