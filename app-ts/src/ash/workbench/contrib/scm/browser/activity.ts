import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { ISCMViewService } from '../common/scm.js';

/** Counts live resources in the repository selected by SCM. */
export class SCMActiveRepositoryController extends Disposable {
	private readonly repositoryListener = this._register(new MutableDisposable<IDisposable>());
	private readonly activity = this._register(new MutableDisposable<IDisposable>());

	constructor(@ISCMViewService private readonly scmViewService: ISCMViewService, @IActivityService private readonly activityService: IActivityService) {
		super();
		this._register(scmViewService.onDidChangeActiveRepository(() => this.selectRepository()));
		this.selectRepository();
	}

	private selectRepository(): void {
		this.repositoryListener.value = this.scmViewService.activeRepository?.provider.onDidChangeResources(() => this.update());
		this.update();
	}

	private update(): void {
		this.activity.clear();
		const provider = this.scmViewService.activeRepository?.provider;
		if (!provider) return;
		// A file can appear in both the staged and working-tree groups; the activity counts it once.
		const count = new Set(provider.groups.flatMap(group => group.resources.map(resource => extUriBiasedIgnorePathCase.getComparisonKey(resource.sourceUri)))).size;
		if (!count) return;
		const description = count === 1 ? localize('scm.activity.oneChange', '1 changed file') : localize('scm.activity.changes', '{0} changed files', count);
		this.activity.value = this.activityService.showViewContainerActivity(WorkbenchViewContainerId.Git, new NumberBadge(count, description));
	}
}
