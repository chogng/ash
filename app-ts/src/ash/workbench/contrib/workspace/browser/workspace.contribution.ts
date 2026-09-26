import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { IWorkspaceTrustManagementService, type IWorkspaceTrustInfo } from '../../../../platform/workspace/common/workspaceTrust.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { StatusbarAlignment, IStatusbarService, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

class WorkspacePermissionStatus extends Disposable implements IWorkbenchContribution {
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private generation = 0;
	private trustInfo: IWorkspaceTrustInfo | undefined;

	constructor(
		private readonly trust: IWorkspaceTrustManagementService,
		private readonly statusbar: IStatusbarService,
	) {
		super();
		this._register(trust.onDidChangeTrust(() => { void this.refresh(); }));
		this._register(onDidChangeNls(() => this.updateEntry()));
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		try {
			const trustInfo = await this.trust.getWorkspaceTrustInfo();
			if (this.isDisposed || generation !== this.generation) return;
			this.trustInfo = trustInfo;
			this.updateEntry();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			console.error('Failed to read workspace trust information', error);
			this.trustInfo = undefined;
			this.updateEntry();
		}
	}

	private updateEntry(): void {
		if (!this.trustInfo || this.trustInfo.isTrusted) {
			this.entry.clear();
			return;
		}
		const text = this.trustInfo.isReadOnly
			? localize('workspaceTrust.readOnlyStatus', 'Read-only folder')
			: localize('workspaceTrust.restrictedStatus', 'Restricted workspace');
		const tooltip = this.trustInfo.isReadOnly
			? localize('workspaceTrust.readOnlyStatusDetail', 'Files in this folder cannot be edited.')
			: localize('workspaceTrust.restrictedStatusDetail', 'Some workspace features are limited by directory permissions.');
		const content = { text, ariaLabel: `${text}. ${tooltip}`, tooltip };
		if (this.entry.value) this.entry.value.update(content);
		else this.entry.value = this.statusbar.addEntry(content, { id: 'ash.status.workspacePermissions', alignment: StatusbarAlignment.Left, priority: 850 });
	}
}

registerWorkbenchContribution(
	'workbench.contrib.workspacePermissionStatus',
	WorkbenchPhase.AfterRestored,
	accessor => new WorkspacePermissionStatus(
		accessor.get(IWorkspaceTrustManagementService),
		accessor.get(IStatusbarService),
	),
);
