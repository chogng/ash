import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { extUriBiasedIgnorePathCase, extUriIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type {
	IAnyWorkspaceIdentifier,
	IWorkspace,
	IWorkspaceChangeEvent,
	IWorkspaceContextService,
	IWorkspaceFolder,
} from "../../../../platform/workspace/common/workspace.js";
import {
	WorkbenchState,
	workspaceFromIdentifier,
} from "../../../../platform/workspace/common/workspace.js";

/** Live renderer projection of the workspace hosted by this window. */
export class WorkspaceContextService extends Disposable implements IWorkspaceContextService {
	private readonly _onDidChangeWorkspace =
		this._register(new Emitter<IWorkspaceChangeEvent>());
	private workspace: IWorkspace;

	readonly onDidChangeWorkspace = this._onDidChangeWorkspace.event;

	constructor(workspace: IAnyWorkspaceIdentifier | IWorkspace) {
		super();
		this.workspace = resolveWorkspace(workspace);
	}

	getWorkspace(): IWorkspace {
		return this.workspace;
	}

	getWorkbenchState(): WorkbenchState {
		if (this.workspace.configuration) {
			return WorkbenchState.WORKSPACE;
		}
		if (this.workspace.folders.length === 1) {
			return WorkbenchState.FOLDER;
		}
		return WorkbenchState.EMPTY;
	}

	getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
		const candidate = resource.with({ query: null, fragment: null });
		let match: IWorkspaceFolder | null = null;
		for (const folder of this.workspace.folders) {
			// Explicit drive and UNC roots belong to Windows even when the renderer runs
			// on another OS. POSIX and remote roots retain their own casing semantics.
			const comparison = folder.uri.scheme === 'file' && (folder.uri.authority || /^\/[a-z]:($|\/)/i.test(folder.uri.path))
				? extUriIgnorePathCase : extUriBiasedIgnorePathCase;
			if (
				comparison.isEqualOrParent(candidate, folder.uri)
				&& (!match || folder.uri.toEncodedComponents().path.length > match.uri.toEncodedComponents().path.length)
			) {
				match = folder;
			}
		}
		return match;
	}

	/** Atomically replaces the current window workspace and publishes its projection. */
	updateWorkspace(next: IAnyWorkspaceIdentifier | IWorkspace): void {
		const workspace = resolveWorkspace(next);
		const previous = this.workspace;
		if (sameWorkspace(previous, workspace)) return;
		this.workspace = workspace;
		this._onDidChangeWorkspace.fire({ previous, workspace });
	}
}

function sameWorkspace(left: IWorkspace, right: IWorkspace): boolean {
	return left.id === right.id &&
		left.configuration?.toString() === right.configuration?.toString() &&
		left.name === right.name &&
		left.remoteAuthority === right.remoteAuthority &&
		left.folders.length === right.folders.length &&
		left.folders.every((folder, index) => {
			const candidate = right.folders[index];
			return candidate !== undefined &&
				folder.id === candidate.id &&
				folder.uri.toString() === candidate.uri.toString() &&
				folder.name === candidate.name &&
				folder.index === candidate.index;
		});
}

function resolveWorkspace(
	workspace: IAnyWorkspaceIdentifier | IWorkspace,
): IWorkspace {
	if (!('folders' in workspace)) return workspaceFromIdentifier(workspace);
	const folders: readonly IWorkspaceFolder[] = Object.freeze(workspace.folders.map(folder => Object.freeze({ ...folder })));
	return Object.freeze({ ...workspace, folders });
}
