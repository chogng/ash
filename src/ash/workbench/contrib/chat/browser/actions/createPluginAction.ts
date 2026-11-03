import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './chatActions.js';

function validatePluginId(value: string): string | undefined {
	return /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/u.test(value.trim()) ? undefined
		: localize('chat.plugin.create.invalidId', 'Use publisher/plugin-name with lowercase letters, numbers and hyphens.');
}

function validateSourcePath(value: string): string | undefined {
	const path = value.trim();
	return path && !/[\\\x00-\x1f\x7f]/u.test(path) && path.split('/').every(segment => segment && segment !== '.' && segment !== '..') ? undefined
		: localize('chat.plugin.create.invalidSource', 'Enter a workspace-relative Skill folder without empty, . or .. segments.');
}

class CreatePluginAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.createPlugin', category: CHAT_CATEGORY,
			title: localize2('chat.plugin.create', 'Create Plugin from Skill...'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
		const input = accessor.get(IQuickInputService);
		const files = accessor.get(IFileService);
		const editors = accessor.get(IEditorService);
		const navigation = accessor.get(IChatSessionNavigationService);
		if (!folders.length) throw new Error(localize('chat.plugin.create.noWorkspace', 'Open a workspace folder before creating a plugin.'));
		let folder = folders[0];
		if (folders.length > 1) {
			using picker = input.createQuickPick<IQuickPickItem & { folder: typeof folder; }>();
			using listeners = new DisposableStore();
			picker.title = localize('chat.plugin.create.workspace', 'Choose the workspace for the new plugin');
			picker.items = folders.map(folder => ({ label: folder.name, description: folder.uri.toString(), folder }));
			const selected = await new Promise<typeof folder | undefined>(resolve => {
				listeners.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item.folder); picker.hide(); } }));
				listeners.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (!selected) return;
			folder = selected;
		}
		const id = (await input.input({ title: localize('chat.plugin.create.id', 'Plugin identifier'), placeHolder: 'publisher/plugin-name', validateInput: async value => validatePluginId(value) }))?.trim();
		if (!id) return;
		const sourcePath = (await input.input({
			title: localize('chat.plugin.create.source', 'Skill folder to include'),
			placeHolder: localize('chat.plugin.create.sourceHint', 'Relative to {0}; the complete folder will be copied', folder.name),
			validateInput: async value => validateSourcePath(value),
		}))?.trim();
		if (!sourcePath || configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const source = URI.joinPath(folder.uri, sourcePath);
		if ((await files.stat(source)).kind !== FileKind.Directory || (await files.stat(URI.joinPath(source, 'SKILL.md'))).kind !== FileKind.File) {
			throw new Error(localize('chat.plugin.create.noSkill', 'Choose a folder containing a regular SKILL.md file.'));
		}
		const name = id.split('/')[1];
		const target = URI.joinPath(folder.uri, name);
		const staging = URI.joinPath(folder.uri, `.ash-plugin-${createUuid()}`);
		const revision = navigation.revision;
		const activeEditor = editors.activeEditor;
		await files.createDirectory(staging);
		try {
			await files.createDirectory(URI.joinPath(staging, 'skills'));
			// The original file provider owns recursive copying and filesystem authority.
			await files.copy(source, URI.joinPath(staging, 'skills', name));
			await files.createDirectory(URI.joinPath(staging, '.ash-plugin'));
			await files.writeFile({
				resource: URI.joinPath(staging, '.ash-plugin', 'plugin.json'), content: JSON.stringify({
					schemaVersion: 1, id, version: '0.1.0', displayName: name,
					compatibility: { ash: '>=0.1.0' }, permissions: [],
					contributions: { skills: [{ id: name, path: `skills/${name}` }] },
				}, null, '\t') + '\n'
			}, { create: true, overwrite: false });
			// Publishing the complete directory rejects collisions without touching the destination.
			await files.rename(staging, target, 'error');
		} catch (error) {
			try { await files.delete(staging, 'ignore', 'recursive'); }
			catch (cleanup) { throw new AggregateError([error, cleanup], localize('chat.plugin.create.cleanup', 'Plugin creation failed. Its temporary folder could not be removed: {0}', staging.toString())); }
			throw error;
		}
		if (navigation.revision === revision && editors.activeEditor === activeEditor) {
			await editors.openEditor({ resource: URI.joinPath(target, '.ash-plugin', 'plugin.json') }, { pinned: true });
		}
	}
}

export function registerCreatePluginAction(): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(CreatePluginAction));
	return registrations;
}
