import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDebugService, type IDebugSource, type IDebugSession } from './debug.js';
import { getUriFromSource } from './debugSource.js';

interface SourcePick extends IQuickPickItem {
	readonly session: IDebugSession;
	readonly source: IDebugSource;
}

/** Lists adapter-known sources, including virtual sources and each execution authority. */
export async function showLoadedScriptMenu(accessor: ServicesAccessor): Promise<void> {
	const debug = accessor.get(IDebugService);
	const editors = accessor.get(IEditorService);
	const identity = accessor.get(IUriIdentityService);
	const log = accessor.get(ILogService);
	const workspace = accessor.get(IWorkspaceContextService);
	using resources = new DisposableStore();
	const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<SourcePick>());
	picker.ariaLabel = picker.placeholder = localize('debug.loadedSourcePicker', 'Select a loaded source');
	picker.busy = true;
	const selected = await new Promise<SourcePick | undefined>((resolve, reject) => {
		let current = true;
		resources.add(
			picker.onDidHide(() => {
				current = false;
				resolve(undefined);
			}),
		);
		resources.add(workspace.onDidChangeWorkspace(() => picker.hide()));
		resources.add(
			picker.onDidAccept(() => {
				const value = picker.selectedItems[0];
				if (value) {
					resolve(value);
					picker.hide();
				}
			}),
		);
		picker.show();
		void Promise.all(
			debug.sessions
				.filter(session => session.capabilities.supportsLoadedSourcesRequest)
				.map(async session => {
					const sources = await session.loadedSources();
					return debug.getSession(session.id) === session
						? sources.map(source => ({
								label: source.name ?? source.path ?? localize('debug.repl.source', 'Source'),
								description: session.name,
								detail: source.path,
								session,
								source,
							}))
						: [];
				}),
		).then(
			items => {
				if (current) {
					picker.items = items.flat();
					picker.busy = false;
				}
			},
			error => {
				if (current) {
					reject(error);
					picker.hide();
				}
			},
		);
	});
	if (!selected) return;
	if (
		debug.getSession(selected.session.id) !== selected.session ||
		selected.session.state === 'terminated' ||
		selected.session.state === 'error'
	)
		throw new CancellationError();
	const resource = getUriFromSource(selected.source, selected.source.path, selected.session.id, identity, log);
	await editors.openEditor(
		{
			resource,
			label: selected.source.name,
			readOnly: resource.scheme === 'debug',
			...(resource.scheme === 'debug' ? { contentType: 'text/plain' } : {}),
		},
		{ pinned: true },
	);
}
