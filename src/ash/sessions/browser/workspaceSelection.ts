import { URI } from '../../base/common/uri.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { observableValue } from '../../base/common/observable.js';
import { localize } from '../../nls.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { getRemoteAuthority, getRemoteWorkspacePath, isRemoteResource } from '../../platform/remote/common/remote.js';
import type { IWorkspace } from '../../platform/workspace/common/workspace.js';
import type { SessionExecutionTarget, SessionWorkspaceSelection } from '../services/sessions/common/session.js';
import { IWorkspacesService } from '../../platform/workspaces/common/workspaces.js';
import { WorkspaceSelectionOrigin, type IWorkspaceSelectionSnapshot } from '../common/workspaceSelection.js';
import { buildAgentHostSessionWorkspace } from '../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../common/sessionWorkspace.js';

export function selectionFromWorkspace(workspace: IWorkspace): SessionWorkspaceSelection {
	if (workspace.folders.length === 0) return { type: 'current' };
	const folders = workspace.folders.map(folder => ({
		label: folder.name,
		target: selectionFromResource(folder.uri),
	}));
	if (folders.length > 1) return { type: 'multiple', folders };
	return folders[0]!.target;
}

function selectionFromResource(resource: URI): SessionExecutionTarget {
	if (!isRemoteResource(resource)) return { type: 'local', root: resource.fsPath };
	if (resource.authority.startsWith('provider+')) {
		const source: unknown = JSON.parse(decodeURIComponent(resource.authority.slice('provider+'.length)));
		if (
			!Array.isArray(source) ||
			source.length !== 2 ||
			source.some(value => typeof value !== 'string' || !value.length)
		) {
			throw new TypeError('Invalid Session runtime authority');
		}
		return {
			type: 'provider',
			providerId: source[0] as string,
			workspace: source[1] as string,
			root: getRemoteWorkspacePath(resource),
		};
	}
	const authority = getRemoteAuthority(resource);
	if (!authority) throw new Error('Remote workspace has no SSH authority');
	return { type: 'ssh', host: authority.host, root: getRemoteWorkspacePath(resource) };
}

/** One picker lifetime owns history loading, focus/cancellation and its observable snapshot. */
export class WorkspaceSelection extends Disposable {
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private readonly snapshot = observableValue<IWorkspaceSelectionSnapshot>(this, {
		folderUri: undefined,
		origin: WorkspaceSelectionOrigin.None,
		state: 'none',
		historyState: 'loading',
	});

	constructor(
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
	) {
		super();
	}

	public pick(
		folders: readonly { readonly label: string; readonly target: SessionExecutionTarget }[],
		accepts: (target: SessionExecutionTarget) => boolean = () => true,
	): Promise<SessionExecutionTarget | undefined> {
		this.pending.clear();
		if (this.isDisposed) {
			return Promise.resolve(undefined);
		}
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		const picker = lifetime.add(
			this.quickInput.createQuickPick<{
				label: string;
				description: string;
				folderUri: URI;
				target: SessionExecutionTarget;
				origin: WorkspaceSelectionOrigin;
			}>(),
		);
		picker.items = folders
			.filter(folder => accepts(folder.target))
			.map(folder => ({
				label: folder.label,
				description: folder.target.root,
				folderUri: sessionWorkspaceUri(buildAgentHostSessionWorkspace(folder.target)!),
				target: folder.target,
				origin: WorkspaceSelectionOrigin.WindowContext,
			}));
		picker.placeholder = localize('sessions.selectExecutionFolder', 'Select a folder for this session');
		picker.ariaLabel = picker.placeholder;
		picker.busy = true;
		this.snapshot.set({
			folderUri: undefined,
			origin: WorkspaceSelectionOrigin.None,
			target: undefined,
			state: picker.items.length ? 'unresolved' : 'noWorkspace',
			historyState: 'loading',
		});
		return new Promise(resolve => {
			let settled = false;
			const finish = (target: SessionExecutionTarget | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(target);
				lifetime.dispose();
			};
			lifetime.add(toDisposable(() => finish(undefined)));
			lifetime.add(
				picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) {
						return;
					}
					this.snapshot.set({
						...this.snapshot.get(),
						folderUri: item.folderUri,
						target: item.target,
						origin:
							item.origin === WorkspaceSelectionOrigin.AgentsRecent
								? item.origin
								: WorkspaceSelectionOrigin.User,
						state: 'selected',
					});
					finish(this.snapshot.get().target);
				}),
			);
			lifetime.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
			void this.workspaces.getRecentlyOpened().then(
				history => {
					if (settled) {
						return;
					}
					const known = new Set(
						picker.items.flatMap(item => ('folderUri' in item ? [item.folderUri.toString()] : [])),
					);
					const recents = history.workspaces.flatMap(recent => {
						if (
							!('folderUri' in recent) ||
							known.has(recent.folderUri.toString()) ||
							(recent.folderUri.scheme !== 'file' && !isRemoteResource(recent.folderUri))
						) {
							return [];
						}
						if (isRemoteResource(recent.folderUri)) {
							try {
								selectionFromResource(recent.folderUri);
							} catch {
								return [];
							}
						}
						const target = selectionFromResource(recent.folderUri);
						if (!accepts(target)) {
							return [];
						}
						known.add(recent.folderUri.toString());
						return [
							{
								label: recent.label ?? recent.folderUri.path,
								description: recent.folderUri.path,
								folderUri: recent.folderUri,
								target,
								origin: WorkspaceSelectionOrigin.AgentsRecent,
							},
						];
					});
					picker.items = [...picker.items, ...recents];
					picker.busy = false;
					this.snapshot.set({ ...this.snapshot.get(), historyState: 'loaded' });
				},
				() => {
					if (settled) {
						return;
					}
					picker.busy = false;
					this.snapshot.set({ ...this.snapshot.get(), historyState: 'error' });
				},
			);
		});
	}
}
