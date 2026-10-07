import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { WorkbenchViewContainerId } from '../../../common/views.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { NumberBadge, type IActivityService } from '../../../services/activity/common/activity.js';
import type { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Keeps the sidebar badge synchronized with dirty working copies. */
export class DirtyFilesIndicator extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.dirtyFilesIndicator';
	private readonly badge = this._register(new MutableDisposable());

	constructor(
		private readonly activityService: IActivityService,
		private readonly workingCopyService: IWorkingCopyService,
	) {
		super();
		this._register(workingCopyService.onDidChangeDirty(() => this.update()));
		this._register(workingCopyService.onDidRegister(() => this.update()));
		this._register(workingCopyService.onDidUnregister(() => this.update()));
		this.update();
	}

	private update(): void {
		const count = this.workingCopyService.getAll().filter(copy => copy.isDirty).length;
		if (count === 0) {
			this.badge.clear();
			return;
		}
		const description = count === 1
			? localize('files.dirtyOne', '1 unsaved file')
			: localize('files.dirtyMany', '{0} unsaved files', count);
		this.badge.value = this.activityService.showViewContainerActivity(
			WorkbenchViewContainerId.Sidebar,
			new NumberBadge(count, description),
		);
	}
}
