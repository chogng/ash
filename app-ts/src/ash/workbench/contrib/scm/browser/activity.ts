import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { StatusbarAlignment, type IStatusbarEntryAccessor, IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { Disposable, DisposableMap, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { ISCMViewService, type ISCMProvider } from '../common/scm.js';

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

/** Displays status commands owned by the selected SCM provider. */
export class ScmStatusContribution extends Disposable implements IWorkbenchContribution {
	private readonly entries = this._register(new DisposableMap<string, IStatusbarEntryAccessor>());
	private readonly providerListener = this._register(new MutableDisposable());

	constructor(
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		this._register(scmViewService.onDidChangeActiveRepository(() => this.bindProvider()));
		this.bindProvider();
	}

	private bindProvider(): void {
		const provider = this.scmViewService.activeRepository?.provider;
		this.providerListener.value = provider?.onDidChangeResources(() => this.update(provider));
		this.update(provider);
	}

	private update(provider: ISCMProvider | undefined): void {
		const commands = provider?.statusBarCommands ?? [];
		const activeIds = new Set(commands.map(command => command.id));
		for (const id of this.entries.keys()) {
			if (!activeIds.has(id)) this.entries.deleteAndDispose(id);
		}
		for (const command of commands) {
			const entry = { icon: command.icon, text: command.text, ariaLabel: command.ariaLabel, tooltip: command.tooltip, run: () => command.run() };
			const current = this.entries.get(command.id);
			if (current) {
				current.update(entry);
				continue;
			}
			this.entries.set(command.id, this.statusbarService.addEntry(entry, {
				id: command.id,
				alignment: StatusbarAlignment.Left,
				priority: command.priority,
				compactGroup: command.compactGroup,
			}));
		}
	}
}
