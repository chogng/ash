import { Emitter, type Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IFileService } from '../../../../platform/files/common/files.js';
import { type IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Routes file-service changes belonging to the current workspace to Explorer. */
export class WorkspaceWatcher extends Disposable {
	private readonly watches = this._register(new DisposableStore());
	private readonly changeEmitter = this._register(new Emitter<readonly URI[] | undefined>());
	readonly onDidChange: Event<readonly URI[] | undefined> = this.changeEmitter.event;
	private readonly pendingResources = new Map<string, URI>();
	private rescanRequired = false;
	// Batch watcher bursts without delaying each new event indefinitely.
	private readonly changeScheduler = this._register(
		new RunOnceScheduler(() => {
			const resources = this.rescanRequired ? undefined : [...this.pendingResources.values()];
			this.pendingResources.clear();
			this.rescanRequired = false;
			this.changeEmitter.fire(resources);
		}, 100),
	);

	constructor(
		private readonly files: IFileService,
		private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.updateWatches();
		this._register(workspace.onDidChangeWorkspace(() => this.updateWatches()));
		this._register(
			files.onDidChangeFiles(event => {
				if (!event.resources) {
					this.rescanRequired = true;
					this.pendingResources.clear();
				} else if (!this.rescanRequired) {
					for (const resource of event.resources) {
						if (workspace.getWorkspaceFolder(resource)) {
							this.pendingResources.set(extUri.getComparisonKey(resource), resource);
						}
					}
				}
				if ((this.rescanRequired || this.pendingResources.size > 0) && !this.changeScheduler.isScheduled()) {
					this.changeScheduler.schedule();
				}
			}),
		);
	}

	private updateWatches(): void {
		this.changeScheduler.cancel();
		this.pendingResources.clear();
		this.rescanRequired = false;
		this.watches.clear();
		for (const folder of this.workspace.getWorkspace().folders) {
			if (this.files.hasProvider(folder.uri)) this.watches.add(this.files.watch(folder.uri, { recursive: true, excludes: [] }));
		}
	}
}
