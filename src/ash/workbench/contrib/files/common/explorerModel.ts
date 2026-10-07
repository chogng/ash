import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileKind, type IFileEntry } from '../../../../platform/files/common/files.js';
import type { IWorkspace, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** One resource shown in the workspace file tree. */
export class ExplorerItem {
	constructor(
		public readonly resource: URI,
		public readonly name: string,
		public readonly kind: FileKind,
		public readonly children?: readonly ExplorerItem[],
	) { }

	public static fromFileEntry(entry: IFileEntry): ExplorerItem {
		return new ExplorerItem(entry.resource, entry.name, entry.kind);
	}
}

/** Owns the Explorer root across view disposal and workspace changes. */
export class ExplorerModel extends Disposable {
	private readonly rootChanged = this._register(new Emitter<void>());
	readonly onDidChangeRoot: Event<void> = this.rootChanged.event;
	private currentRoot: ExplorerItem | undefined;

	constructor(workspace: IWorkspaceContextService) {
		super();
		this.currentRoot = explorerRoot(workspace.getWorkspace());
		this._register(workspace.onDidChangeWorkspace(({ workspace }) => {
			this.currentRoot = explorerRoot(workspace);
			this.rootChanged.fire();
		}));
	}

	get root(): ExplorerItem | undefined {
		return this.currentRoot;
	}
}

function explorerRoot(workspace: IWorkspace): ExplorerItem | undefined {
	const roots = workspace.folders.map(folder => new ExplorerItem(folder.uri, folder.name, FileKind.Directory));
	if (roots.length === 0) return undefined;
	if (roots.length === 1) return roots[0];
	return new ExplorerItem(
		URI.parse(`ash-workspace:/${encodeURIComponent(workspace.id)}`),
		workspace.name ?? 'Workspace',
		FileKind.Directory,
		Object.freeze(roots),
	);
}
