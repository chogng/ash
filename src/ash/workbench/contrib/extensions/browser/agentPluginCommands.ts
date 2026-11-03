import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../platform/extensionManagement/common/extensionManagementService.js';

/** Registers the package commands on the Extensions surface that owns their pickers. */
export function registerAgentPluginCommands(): DisposableStore {
	const registrations = new DisposableStore();
	const extensionsTitle = ContextKeyExpr.equals('viewContainer', 'ash.extensions');
	registrations.add(registerAction2(class InstallLocalExtension extends Action2 {
		constructor() {
			super({
				id: 'ash.extensions.installLocal',
				get title() { return localize2({ bundle: 'ash.extensions', key: 'installLocalExtension' }, 'Install extension from workspace'); },
				f1: true,
				menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '3_install', order: 1 },
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginManagementService);
			const dialogs = accessor.get(IDialogService);
			const catalog = await plugins.list();
			const input = await dialogs.input({
				title: localize({ bundle: 'ash.extensions', key: 'installLocalExtension' }, 'Install extension from workspace'),
				message: localize({ bundle: 'ash.extensions', key: 'localExtensionPath' }, 'Enter the extension package path relative to the selected workspace directory.'),
				detail: localize({ bundle: 'ash.extensions', key: 'localExtensionInstallNotice' }, 'The package must contain .ash-plugin/plugin.json. Installation copies the package into your profile; enablement and permissions are managed separately.'),
				inputs: [{ placeholder: 'examples/extensions/inspect' }],
				primaryButton: localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'),
			});
			if (!input.confirmed) { return; }
			const installed = await plugins.installLocal(input.values?.[0]?.trim() ?? '', catalog.revision);
			await dialogs.info(localize({ bundle: 'ash.extensions', key: 'localExtensionInstalled' }, 'Installed {0} {1}. Use Manage local extensions to enable it and review its permissions.', installed.id, installed.version));
		}
	}));
	registrations.add(registerAction2(class InstallGitExtension extends Action2 {
		constructor() {
			super({
				id: 'ash.extensions.installFromGit', title: localize2({ bundle: 'ash.extensions', key: 'installGitExtension' }, 'Install extension from Git repository'),
				f1: true,
				menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '3_install', order: 2 },
			});
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginManagementService);
			const dialogs = accessor.get(IDialogService);
			const quickInput = accessor.get(IQuickInputService);
			const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
			if (folders.length === 0) {
				await dialogs.info(localize({ bundle: 'ash.extensions', key: 'gitInstallWorkspace' }, 'Open a workspace folder to install an extension from Git.'));
				return;
			}
			let folder = folders[0]!;
			if (folders.length > 1) {
				using selection = new DisposableStore();
				const picker = selection.add(quickInput.createQuickPick<IQuickPickItem & { readonly folderId: string; }>());
				picker.ariaLabel = localize({ bundle: 'ash.extensions', key: 'gitInstallFolder' }, 'Choose the workspace folder for the temporary checkout');
				picker.items = folders.map(folder => ({ label: folder.name, description: folder.uri.toString(), folderId: folder.id }));
				const selected = await new Promise<string | undefined>(resolve => {
					selection.add(picker.onDidAccept(() => {
						const item = picker.selectedItems[0];
						if (!item) return;
						resolve(item.folderId); picker.hide();
					}));
					selection.add(picker.onDidHide(() => resolve(undefined)));
					picker.show();
				});
				if (!selected) { return; }
				folder = folders.find(folder => folder.id === selected)!;
			}
			const input = await dialogs.input({
				title: localize({ bundle: 'ash.extensions', key: 'installGitExtension' }, 'Install extension from Git repository'),
				message: localize({ bundle: 'ash.extensions', key: 'gitInstallSource' }, 'Enter the repository URL, optional branch, tag or full commit ID, and package directory.'),
				detail: localize({ bundle: 'ash.extensions', key: 'gitInstallNotice' }, 'The package directory defaults to the repository root and must contain .ash-plugin/plugin.json. Installation uses a temporary checkout in {0}; enablement and permissions are managed separately.', folder.name),
				inputs: [
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'gitRepositoryUrl' }, 'Git repository URL') },
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'gitReference' }, 'Branch, tag or full commit ID (optional)') },
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'gitPackagePath' }, 'Package directory (optional)'), value: '.' },
				],
				primaryButton: localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'),
			});
			if (!input.confirmed) { return; }
			const url = input.values?.[0]?.trim() ?? '';
			const reference = input.values?.[1]?.trim() || undefined;
			const packagePath = input.values?.[2]?.trim() ?? '';
			using running = new DisposableStore();
			const controller = new AbortController();
			const progress = running.add(quickInput.createQuickPick<IQuickPickItem>());
			progress.ariaLabel = localize({ bundle: 'ash.extensions', key: 'gitInstallProgress' }, 'Installing extension from Git. Press Escape to cancel.');
			progress.placeholder = progress.ariaLabel;
			progress.busy = true;
			progress.items = [{ label: localize({ bundle: 'ash.extensions', key: 'cancelGitInstall' }, 'Cancel installation') }];
			running.add(progress.onDidAccept(() => { controller.abort(); progress.hide(); }));
			running.add(progress.onDidHide(() => controller.abort()));
			progress.show();
			try {
				const installed = await plugins.installFromGit(folder, url, reference, packagePath, controller.signal);
				progress.hide();
				await dialogs.info(localize({ bundle: 'ash.extensions', key: 'localExtensionInstalled' }, 'Installed {0} {1}. Use Manage local extensions to enable it and review its permissions.', installed.id, installed.version));
			} catch (error) {
				if (!controller.signal.aborted && !isCancellationError(error)) { throw error; }
			} finally {
				progress.hide();
			}
		}
	}));
	registrations.add(registerAction2(class ManageLocalExtensions extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageLocal', get title() { return localize2({ bundle: 'ash.extensions', key: 'manageLocalExtensions' }, 'Manage local extensions'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { view: 'plugins', mode: 'installed' });
		}
	}));
	return registrations;
}
