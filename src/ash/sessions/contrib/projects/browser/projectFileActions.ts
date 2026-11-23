import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenusRegistry, type IMenuService } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INativeHostService } from '../../../../workbench/common/services.js';
import { Menus } from '../../../browser/menus.js';
import type { SessionsCatalogProjectFile } from '../../sessions/browser/views/sessionsCatalogList.js';

export async function confirmProjectFileRemoval(dialogs: IDialogService, names: readonly string[]): Promise<boolean> {
	return (await dialogs.confirm({
		message: names.length === 1
			? localize('projects.confirmRemoveMaterial', 'Remove {0} from this project?', names[0])
			: localize('projects.confirmRemoveFiles', 'Remove {0} files from this project?', names.length),
		primaryButton: localize('projects.confirmRemoveMaterialAction', 'Remove'),
		detail: localize('projects.removeFileDetail', 'This also deletes the copies and unsaved changes stored by Ash for these project files. Original files on disk are kept.'),
		destructive: true,
	})).confirmed;
}

const actions = [
	{ key: 'rename', icon: Lxicon.edit, title: localize('sessions.list.rename', 'Rename') },
	{ key: 'remove', icon: Lxicon.trash, title: localize('projects.delete', 'Delete'), destructive: true },
	{
		key: 'reveal', icon: Lxicon.folder, title: isMacintosh
			? localize({ bundle: 'ash', key: 'files.revealInMac' }, 'Reveal in Finder')
			: isWindows ? localize({ bundle: 'ash', key: 'files.revealInWindows' }, 'Reveal in File Explorer')
				: localize({ bundle: 'ash', key: 'files.revealInLinux' }, 'Open Containing Folder')
	},
] as const;
type FileAction = typeof actions[number]['key'];
type FileMenuTarget = Partial<Record<FileAction, () => void | Promise<void>>>;

CommandsRegistry.registerMany(actions.map(({ key }) => ({
	id: `sessions.sidebarProjectFile.${key}`,
	handler: (_accessor, target) => {
		const run = (target as FileMenuTarget | undefined)?.[key];
		if (typeof run === 'function') return run();
	},
})));
MenusRegistry.appendMenuItems(actions.map(({ key, ...presentation }, order) => ({
	id: Menus.SidebarChatProjectFileContext,
	item: { command: { id: `sessions.sidebarProjectFile.${key}`, ...presentation }, group: 'file', order, when: ContextKeyExpr.has(`sidebarProjectFile.${key}`) },
})));

export const revealCommand = 'sessions.sidebarProjectFile.revealResource';
CommandsRegistry.register(revealCommand, async (accessor, reveal) => {
	if (typeof reveal !== 'function') return;
	const nativeHost = accessor.get(INativeHostService);
	const resource = await (reveal as NonNullable<SessionsCatalogProjectFile['reveal']>)();
	if (resource?.scheme === 'file' && !resource.authority) await nativeHost.revealFile(resource.fsPath);
});

export function projectFileMenuActions(menus: IMenuService, context: IContextKeyService | undefined, fileActions: FileMenuTarget,
	destinations: SessionsCatalogProjectFile['destinations'], run: (operation: () => Promise<void>) => Promise<void>): IAction[] {
	context?.bufferChangeEvents(() => {
		for (const { key } of actions) context.setContext(`sidebarProjectFile.${key}`, !!fileActions[key]);
	});
	const contributed = getFlatContextMenuActions(menus.getMenuActions(Menus.SidebarChatProjectFileContext, { arg: fileActions }, context));
	const targets = destinations?.map(({ id, title, move }): IAction => ({
		id: `sessions.sidebarProjectFile.move.${id}`, label: title, tooltip: title, icon: Lxicon.projects, enabled: true, run: () => run(move),
	}));
	return Separator.join(contributed, targets?.length ? [new SubmenuAction('sessions.sidebarProjectFile.move',
		localize('sessions.list.moveToProject', 'Move to project'), targets, Lxicon.projects)] : []);
}
