import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { IDirPermissionsService } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IWorkspaceContextService, workspaceOpenTarget } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { StatusbarAlignment, IStatusbarService, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

class WorkspacePermissionStatus extends Disposable implements IWorkbenchContribution {
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private generation = 0;
	private readOnly = false;

	constructor(
		private readonly workspace: IWorkspaceContextService,
		private readonly permissions: IDirPermissionsService,
		private readonly statusbar: IStatusbarService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => { void this.refresh(); }));
		this._register(permissions.onDidChangePermissions(() => { void this.refresh(); }));
		this._register(onDidChangeNls(() => this.updateEntry()));
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const current = this.workspace.getWorkspace();
		const path = current.folders.length === 1 ? workspaceOpenTarget(current) : undefined;
		if (!path) {
			this.readOnly = false;
			this.updateEntry();
			return;
		}
		try {
			const permissions = await this.permissions.read(path);
			if (this.isDisposed || generation !== this.generation) return;
			this.readOnly = permissions !== undefined && !permissions.includes('writeFiles');
			this.updateEntry();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			console.error('Failed to read workspace directory permissions', error);
			this.readOnly = false;
			this.updateEntry();
		}
	}

	private updateEntry(): void {
		if (!this.readOnly) {
			this.entry.clear();
			return;
		}
		const text = localize('workspaceTrust.readOnlyStatus', 'Read-only folder');
		const tooltip = localize('workspaceTrust.readOnlyStatusDetail', 'Files in this folder cannot be edited.');
		const content = { text, ariaLabel: `${text}. ${tooltip}`, tooltip };
		if (this.entry.value) this.entry.value.update(content);
		else this.entry.value = this.statusbar.addEntry(content, { id: 'ash.status.workspacePermissions', alignment: StatusbarAlignment.Left, priority: 850 });
	}
}

registerWorkbenchContribution(
	'workbench.contrib.workspacePermissionStatus',
	WorkbenchPhase.AfterRestored,
	accessor => new WorkspacePermissionStatus(
		accessor.get(IWorkspaceContextService),
		accessor.get(IDirPermissionsService),
		accessor.get(IStatusbarService),
	),
);
