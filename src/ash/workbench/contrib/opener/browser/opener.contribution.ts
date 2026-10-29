import { Disposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { FileKind, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService, extractSelection, type IOpener, type OpenOptions } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeHostService } from '../../../common/services.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../files/browser/fileConstants.js';

/** Routes folder links before the code-editor fallback, borrowing the existing file authority. */
export class WorkbenchOpenerContribution extends Disposable implements IOpener {
	public static readonly ID = 'workbench.contrib.opener';

	constructor(
		private readonly revealLocalFolder: ((resource: URI) => Promise<void>) | undefined,
		@IOpenerService opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
		this._register(opener.registerOpener(this));
	}

	public async open(link: URI | string, options?: OpenOptions): Promise<boolean> {
		if (options?.openExternal) {
			return false;
		}
		let { uri } = extractSelection(typeof link === 'string' ? URI.parse(link) : link);
		if (uri.scheme === 'file') uri = uri.with({ path: posix.normalize(uri.path) });
		const insideWorkspace = this.workspace.getWorkspaceFolder(uri) !== null;
		const revealInOS = uri.scheme === 'file' && this.contextKeys.getValue(IsSessionsWindowContext.key) === true && this.revealLocalFolder;
		if ((!insideWorkspace && !revealInOS) || !this.files.hasProvider(uri)) {
			return false;
		}
		try {
			if ((await this.files.stat(uri)).kind !== FileKind.Directory) {
				return false;
			}
		} catch (error) {
			if (error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
				return false;
			}
			throw error;
		}
		// A late stat response must not navigate after its window has closed or changed workspace.
		if (this.isDisposed) return false;
		if (insideWorkspace) {
			if (!this.workspace.getWorkspaceFolder(uri)) return false;
			await this.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, uri);
		} else if (revealInOS) {
			await revealInOS(uri);
		}
		return true;
	}
}

registerWorkbenchContribution(WorkbenchOpenerContribution.ID, WorkbenchPhase.AfterRestored, accessor => {
	// Native capability selection belongs to this composition boundary; browser windows have no OS reveal route.
	const native = accessor.getOptional(INativeHostService);
	return accessor.get(IInstantiationService).createInstance(WorkbenchOpenerContribution, native ? (resource: URI) => native.revealFile(resource.fsPath) : undefined);
});
