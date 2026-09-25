import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INativeHostService } from '../../../common/services.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ResourceSchemeContext } from '../../../common/contextkeys.js';
import { IExplorerService } from '../browser/files.js';
import { revealResourcesInOS } from './fileCommands.js';

export const REVEAL_IN_OS_COMMAND_ID = 'revealFileInOS';
export const REVEAL_ACTIVE_FILE_IN_OS_COMMAND_ID = 'workbench.action.files.revealActiveFileInWindows';

function revealLabel(): string {
	return isWindows
		? localize({ bundle: 'ash', key: 'files.revealInWindows' }, 'Reveal in File Explorer')
		: isMacintosh
			? localize({ bundle: 'ash', key: 'files.revealInMac' }, 'Reveal in Finder')
			: localize({ bundle: 'ash', key: 'files.revealInLinux' }, 'Open Containing Folder');
}

registerAction2(class RevealFileInOSAction extends Action2 {
	constructor() {
		super({
			id: REVEAL_IN_OS_COMMAND_ID,
			title: revealLabel(),
			f1: true,
			menu: [
				{ id: MenuId.ExplorerContext, group: 'navigation', order: 20 },
				{ id: MenuId.EditorTitle, when: ResourceSchemeContext.isEqualTo(Schemas.file), group: 'navigation', order: 20 },
			],
		});
	}

	override run(accessor: ServicesAccessor, resource?: unknown): Promise<void> {
		if (resource !== undefined && !(resource instanceof URI)) throw new TypeError('Reveal requires a resource URI');
		const selected = accessor.get(IExplorerService).getContext().map(item => item.resource);
		const active = accessor.get(IEditorService).activeEditor?.resource;
		const resources = resource instanceof URI ? [resource] : selected.length > 0 ? selected : active ? [active] : [];
		return revealResourcesInOS(resources, accessor.get(INativeHostService), accessor.get(IWorkspaceContextService));
	}
});

registerAction2(class RevealActiveFileInOSAction extends Action2 {
	constructor() {
		super({
			id: REVEAL_ACTIVE_FILE_IN_OS_COMMAND_ID,
			title: revealLabel(),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const active = accessor.get(IEditorService).activeEditor?.resource;
		return revealResourcesInOS(active ? [active] : [], accessor.get(INativeHostService), accessor.get(IWorkspaceContextService));
	}
});
