import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IFileService } from '../../../../platform/files/common/files.js';
import { type IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Routes file-service changes belonging to the current workspace to Explorer. */
export class WorkspaceWatcher extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<readonly URI[] | undefined>());
	readonly onDidChange: Event<readonly URI[] | undefined> = this.changeEmitter.event;

	constructor(files: IFileService, workspace: IWorkspaceContextService) {
		super();
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources) {
				this.changeEmitter.fire(undefined);
				return;
			}
			const folders = workspace.getWorkspace().folders;
			const affected = event.resources.filter(resource => folders.some(folder =>
				extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.uri)));
			if (affected.length > 0) this.changeEmitter.fire(affected);
		}));
	}
}
