import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID, OPEN_PLUGINS_COMMAND_ID, type MarketplaceEditorExtensionPolicy, type MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPluginService, type PluginPackageView, type PluginPermission } from '../../../../platform/plugins/common/pluginService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { MarketplaceViewPane } from './marketplaceViewPane.js';

registerWorkbenchContribution('workbench.contrib.marketplace', WorkbenchPhase.BlockStartup, () => {
	const registrations = new DisposableStore();
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.marketplace', title: 'Marketplace', location: ViewContainerLocation.Sidebar, icon: Lxicon.extensions, order: 8 }));
	registrations.add(ViewsRegistry.registerViews('ash.marketplace', [{ id: 'ash.marketplace.view', title: 'Marketplace', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(MarketplaceViewPane) }]));
	registrations.add(registerAction2(class OpenMarketplace extends Action2 {
		constructor() { super({ id: OPEN_MARKETPLACE_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenMarketplace' }, 'Open Marketplace'), f1: true }); }
		public override async run(accessor: ServicesAccessor, options?: MarketplaceOpenOptions | string): Promise<void> {
			const view = await accessor.get(IViewsService).openView('ash.marketplace.view');
			// Catalog loading and its errors belong to the view; navigation must release the Chat composer immediately.
			if (view instanceof MarketplaceViewPane) { void view.open(typeof options === 'string' ? { query: options.trim() } : options); }
		}
	}));
	registrations.add(registerAction2(class OpenPlugins extends Action2 {
		constructor() { super({ id: OPEN_PLUGINS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenPlugins' }, 'Manage installed packages'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await accessor.get(IViewsService).openView('ash.marketplace.view');
			if (view instanceof MarketplaceViewPane) { void view.open({ mode: 'installed' }); }
		}
	}));
	registrations.add(registerAction2(class InstallLocalExtension extends Action2 {
		constructor() { super({ id: 'ash.extensions.installLocal', get title() { return localize2({ bundle: 'ash.marketplace', key: 'installLocalExtension' }, 'Install extension from workspace'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginService);
			const dialogs = accessor.get(IDialogService);
			const catalog = await plugins.list();
			const input = await dialogs.input({
				title: localize({ bundle: 'ash.marketplace', key: 'installLocalExtension' }, 'Install extension from workspace'),
				message: localize({ bundle: 'ash.marketplace', key: 'localExtensionPath' }, 'Enter the extension package path relative to the selected workspace directory.'),
				detail: localize({ bundle: 'ash.marketplace', key: 'localExtensionInstallNotice' }, 'The package must contain .ash-plugin/plugin.json. Installation copies the package into your profile; enablement and permissions are managed separately.'),
				inputs: [{ placeholder: '.build/extension-sdk' }],
				primaryButton: localize({ bundle: 'ash.marketplace', key: 'install' }, 'Install'),
			});
			if (!input.confirmed) { return; }
			const installed = await plugins.installLocal(input.values?.[0]?.trim() ?? '', catalog.revision);
			await dialogs.info(localize({ bundle: 'ash.marketplace', key: 'localExtensionInstalled' }, 'Installed {0} {1}. Use Manage local extensions to enable it and review its permissions.', installed.id, installed.version));
		}
	}));
	registrations.add(registerAction2(class ManageLocalExtensions extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageLocal', get title() { return localize2({ bundle: 'ash.marketplace', key: 'manageLocalExtensions' }, 'Manage local extensions'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginService);
			const dialogs = accessor.get(IDialogService);
			const quickInput = accessor.get(IQuickInputService);
			const catalog = await plugins.list();
			const packages = catalog.packages.filter(plugin => plugin.hasEditorExtensions);
			if (packages.length === 0) {
				await dialogs.info(localize({ bundle: 'ash.marketplace', key: 'noLocalExtensions' }, 'No local editor extensions are installed. Use Install extension from workspace to add one.'));
				return;
			}
			using disposables = new DisposableStore();
			const picker = disposables.add(quickInput.createQuickPick<IQuickPickItem & { readonly plugin: PluginPackageView; }>());
			picker.ariaLabel = localize({ bundle: 'ash.marketplace', key: 'manageLocalExtensions' }, 'Manage local extensions');
			picker.placeholder = localize({ bundle: 'ash.marketplace', key: 'chooseLocalExtension' }, 'Select an extension to manage');
			picker.items = packages.map(plugin => ({
				label: plugin.displayName,
				description: `${plugin.id} · ${plugin.version}`,
				detail: localize({ bundle: 'ash.marketplace', key: 'localExtensionState' }, 'Enabled: {0}. Permissions granted: {1}. Revoked: {2}.', yesNo(plugin.enabled), yesNo(plugin.granted), yesNo(plugin.revoked)),
				plugin,
			}));
			const selected = await new Promise<PluginPackageView | undefined>(resolve => {
				disposables.add(picker.onDidAccept(item => { resolve(item.plugin); picker.hide(); }));
				disposables.add(picker.onDidHide(() => resolve(undefined)));
				disposables.add(picker.onDidBlur(() => picker.hide()));
				picker.show();
			});
			if (!selected) { return; }
			const buttons = [];
			if (selected.enabled || !selected.revoked) {
				buttons.push({ label: selected.enabled ? localize({ bundle: 'ash.marketplace', key: 'disableLocalExtension' }, 'Disable') : localize({ bundle: 'ash.marketplace', key: 'enableLocalExtension' }, 'Enable'), run: () => selected.enabled ? plugins.disable(selected, catalog.revision) : plugins.enable(selected, catalog.revision) });
			}
			if (selected.granted || !selected.revoked) {
				buttons.push({ label: selected.granted ? localize({ bundle: 'ash.marketplace', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.marketplace', key: 'grantLocalExtension' }, 'Grant permissions'), run: () => selected.granted ? plugins.revokeGrant(selected, catalog.revision) : plugins.grant(selected, catalog.revision) });
			}
			if (!selected.enabled && !selected.granted) {
				buttons.push({ label: localize({ bundle: 'ash.marketplace', key: 'uninstall' }, 'Uninstall'), run: () => plugins.uninstall(selected, catalog.revision) });
			}
			await dialogs.prompt({
				title: selected.displayName,
				message: `${selected.id} · ${selected.version}`,
				detail: [
					localize({ bundle: 'ash.marketplace', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', selected.permissions.length ? selected.permissions.map(describePermission).join('; ') : localize({ bundle: 'ash.marketplace', key: 'noPermissions' }, 'None')),
					localize({ bundle: 'ash.marketplace', key: 'localExtensionDocumentNotice' }, 'VS Code extensions use the product Node host with user-level filesystem, network and child-process access and inherited developer environment variables. Ash SDK extensions retain the confined V8 host. Editor callbacks can receive unsaved text. Grant permissions only to packages you trust.'),
					localize({ bundle: 'ash.marketplace', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.digest),
				].join('\n\n'),
				buttons,
			});
		}
	}));
	registrations.add(registerAction2(class ManageMarketplaceExtensions extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageMarketplace', title: localize2({ bundle: 'ash.marketplace', key: 'manageMarketplaceExtensions' }, 'Manage Marketplace extension execution'), f1: true }); }
		async run(accessor: ServicesAccessor): Promise<void> {
			const marketplace = accessor.get(IMarketplaceService);
			const dialogs = accessor.get(IDialogService);
			const quickInput = accessor.get(IQuickInputService);
			const catalog = await marketplace.listEditorExtensions();
			if (!catalog.extensions.length) {
				await dialogs.info(localize({ bundle: 'ash.marketplace', key: 'noMarketplaceExtensions' }, 'No Marketplace editor extensions are installed. Install one from the Open VSX catalog first.'));
				return;
			}
			using disposables = new DisposableStore();
			const picker = disposables.add(quickInput.createQuickPick<IQuickPickItem & { readonly extension: MarketplaceEditorExtensionPolicy; }>());
			picker.ariaLabel = localize({ bundle: 'ash.marketplace', key: 'manageMarketplaceExtensions' }, 'Manage Marketplace extension execution');
			picker.placeholder = localize({ bundle: 'ash.marketplace', key: 'chooseLocalExtension' }, 'Select an extension to manage');
			picker.items = catalog.extensions.map(extension => ({
				label: extension.package.id, description: extension.package.version,
				detail: extension.entrypoint === null ? localize({ bundle: 'ash.marketplace', key: 'noExecutableEntry' }, 'Script execution is unavailable for this package or platform.') : localize({ bundle: 'ash.marketplace', key: 'marketplaceExtensionState' }, 'Enabled: {0}. Execution authorized: {1}.', yesNo(extension.enabled), yesNo(extension.granted)), extension
			}));
			const selected = await new Promise<MarketplaceEditorExtensionPolicy | undefined>(resolve => {
				disposables.add(picker.onDidAccept(item => { resolve(item.extension); picker.hide(); }));
				disposables.add(picker.onDidHide(() => resolve(undefined)));
				disposables.add(picker.onDidBlur(() => picker.hide()));
				picker.show();
			});
			if (!selected) { return; }
			if (selected.entrypoint === null && !selected.enabled && !selected.granted) {
				await dialogs.info(localize({ bundle: 'ash.marketplace', key: 'noExecutableEntry' }, 'Script execution is unavailable for this package or platform.'));
				return;
			}
			await dialogs.prompt({
				title: selected.package.id, message: selected.package.version,
				detail: [localize({ bundle: 'ash.marketplace', key: 'marketplaceExecutionNotice' }, 'Authorize this exact extension to run in the product Node host with your user-level filesystem, network and child-process access, including inherited developer environment variables. Editor APIs receive documents including unsaved text. Disable execution before uninstalling. Package or execution-contract changes require new authorization.'),
				localize({ bundle: 'ash.marketplace', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.package.digest)].join('\n\n'),
				buttons: [
					...(selected.enabled || selected.entrypoint !== null ? [{ label: selected.enabled ? localize({ bundle: 'ash.marketplace', key: 'disableLocalExtension' }, 'Disable') : localize({ bundle: 'ash.marketplace', key: 'enableLocalExtension' }, 'Enable'), run: () => marketplace.setEditorExtensionPolicy(selected, selected.enabled ? 'disable' : 'enable', catalog.revision) }] : []),
					...(selected.granted || selected.entrypoint !== null ? [{ label: selected.granted ? localize({ bundle: 'ash.marketplace', key: 'revokeMarketplaceExecution' }, 'Revoke execution authorization') : localize({ bundle: 'ash.marketplace', key: 'grantMarketplaceExecution' }, 'Authorize execution'), run: () => marketplace.setEditorExtensionPolicy(selected, selected.granted ? 'revoke' : 'grant', catalog.revision) }] : []),
				],
			});
		}
	}));
	return registrations;
});

function yesNo(value: boolean): string {
	return value ? localize({ bundle: 'ash.marketplace', key: 'yes' }, 'Yes') : localize({ bundle: 'ash.marketplace', key: 'no' }, 'No');
}

function describePermission(permission: PluginPermission): string {
	switch (permission.type) {
		case 'directory': return permission.access === 'read' ? localize({ bundle: 'ash.marketplace', key: 'permissionRead' }, 'Read workspace files') : localize({ bundle: 'ash.marketplace', key: 'permissionWrite' }, 'Write workspace files');
		case 'process': return localize({ bundle: 'ash.marketplace', key: 'permissionProcess' }, 'Run {0}', permission.executable);
		case 'network': return localize({ bundle: 'ash.marketplace', key: 'permissionNetwork' }, 'Access network hosts: {0}', permission.hosts.join(', '));
	}
}

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OPEN_MARKETPLACE_COMMAND_ID, title: localize2({ bundle: 'ash', key: 'workbench.manageExtensions' }, 'Extensions') },
	group: '2_configuration',
	order: 3,
});
