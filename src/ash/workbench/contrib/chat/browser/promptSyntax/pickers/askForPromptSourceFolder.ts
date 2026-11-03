import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import type { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { filterQuickPickItems } from '../../../../../../platform/quickinput/browser/quickInputList.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { IWorkspaceFolder } from '../../../../../../platform/workspace/common/workspace.js';

interface FolderItem extends IQuickPickItem {
	readonly folder: URI;
}

/** Selects an existing workspace owner; catalog configuration is not changed here. */
export async function askForPromptSourceFolder(folders: readonly IWorkspaceFolder[], quickInput: IQuickInputService, notifications: INotificationService): Promise<URI | undefined> {
	if (folders.length === 0) {
		notifications.info(localize('prompt.create.openFolder', 'Open a workspace folder to create an Agent or Instruction definition.'));
		return undefined;
	}
	if (folders.length === 1) { return folders[0].uri; }
	using lifetime = new DisposableStore();
	const picker = lifetime.add(quickInput.createQuickPick<FolderItem>());
	const items = folders.map(folder => ({ label: folder.name, description: folder.uri.toString(), folder: folder.uri }));
	picker.items = items;
	picker.placeholder = picker.ariaLabel = localize('prompt.create.folder', 'Select the workspace folder for this definition');
	lifetime.add(picker.onDidChangeValue(value => { picker.items = filterQuickPickItems(items, value); }));
	return await new Promise(resolve => {
		lifetime.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) { return; }
			resolve(item.folder);
			picker.hide();
		}));
		lifetime.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}
