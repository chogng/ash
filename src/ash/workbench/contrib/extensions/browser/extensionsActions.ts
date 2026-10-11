import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsEditorExtensionPolicy } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPluginService, type PluginPackageView, type PluginPermission } from '../../../../platform/plugins/common/pluginService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { createBrowserExtensionApi } from '../../../../platform/extensions/browser/extensionApi.js';
import { ExtensionsInputSource, type ExtensionsInput } from '../common/extensionsInput.js';

/** Both product windows use the same source, package and execution operations. */
export function registerExtensionManagementActions(): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(class ManageBuiltInExtensions extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageBuiltIn', get title() { return localize2({ bundle: 'ash.extensions', key: 'manageBuiltInExtensions' }, 'Manage built-in editor extensions'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'builtIn' });
		}
	}));
	registrations.add(registerAction2(class ManageExtensionSources extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageSources', title: localize2({ bundle: 'ash.extensions', key: 'manageSources' }, 'Manage extension sources'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const service = accessor.get(IExtensionManagementService);
			const dialogs = accessor.get(IDialogService);
			const catalog = await service.sources();
			using resources = new DisposableStore();
			const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<IQuickPickItem & { readonly sourceId?: string; }>());
			picker.ariaLabel = localize({ bundle: 'ash.extensions', key: 'manageSources' }, 'Manage extension sources');
			picker.items = [
				{ label: localize({ bundle: 'ash.extensions', key: 'addSource' }, 'Add Ash open source…') },
				...catalog.sources.map(source => ({
					label: source.id, sourceId: source.id,
					description: source.kind === 'openVsx' ? 'Open VSX' : localize({ bundle: 'ash.extensions', key: 'ashSource' }, 'Ash open source'),
					detail: source.productOwned ? localize({ bundle: 'ash.extensions', key: 'productSource' }, 'Product source') : source.enabled ? localize({ bundle: 'ash.extensions', key: 'sourceEnabled' }, 'Enabled · select to pause') : localize({ bundle: 'ash.extensions', key: 'sourcePaused' }, 'Paused · select to resume'),
				})),
			];
			const selected = await new Promise<(IQuickPickItem & { readonly sourceId?: string; }) | undefined>(resolve => {
				resources.add(picker.onDidAccept(item => { resolve(item); picker.hide(); }));
				resources.add(picker.onDidHide(() => resolve(undefined)));
				resources.add(picker.onDidBlur(() => picker.hide()));
				picker.show();
			});
			if (!selected) { return; }
			if (selected.sourceId) {
				const source = catalog.sources.find(source => source.id === selected.sourceId)!;
				if (!source.productOwned) { await service.setSourceEnabled(source.id, !source.enabled, catalog.revision); }
				return;
			}
			const input = await dialogs.input({
				title: localize({ bundle: 'ash.extensions', key: 'addSource' }, 'Add Ash open source…'),
				message: localize({ bundle: 'ash.extensions', key: 'sourceSetup' }, 'Enter the registry endpoints and trusted signing root provided by its publisher.'),
				detail: localize({ bundle: 'ash.extensions', key: 'sourceIdentity' }, 'Choose a unique source ID. Package identities are scoped to this source. Its endpoints and signing root cannot be replaced under the same ID.'),
				inputs: [
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'sourceId' }, 'Source ID') },
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'metadataUrl' }, 'HTTPS metadata URL') },
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'targetsUrl' }, 'HTTPS packages URL') },
					{ placeholder: localize({ bundle: 'ash.extensions', key: 'trustedRoot' }, 'Trusted root JSON') },
				],
				primaryButton: localize({ bundle: 'ash.extensions', key: 'add' }, 'Add'),
			});
			if (!input.confirmed) { return; }
			const values = input.values ?? [];
			await service.addSource({ sourceId: values[0]?.trim() ?? '', metadataBaseUrl: values[1]?.trim() ?? '', targetsBaseUrl: values[2]?.trim() ?? '', trustedRootJson: values[3]?.trim() ?? '' }, catalog.revision);
		}
	}));
	registrations.add(registerAction2(class InstallLocalExtension extends Action2 {
		constructor() { super({ id: 'ash.extensions.installLocal', get title() { return localize2({ bundle: 'ash.extensions', key: 'installLocalExtension' }, 'Install extension from workspace'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginService);
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
	registrations.add(registerAction2(class ManageLocalExtensions extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageLocal', get title() { return localize2({ bundle: 'ash.extensions', key: 'manageLocalExtensions' }, 'Manage local extensions'); }, f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { view: 'plugins', mode: 'installed' });
		}
	}));
	registrations.add(registerAction2(class ManageExtensionExecution extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageExtensions', title: localize2({ bundle: 'ash.extensions', key: 'manageExtensionExecution' }, 'Manage extension execution'), f1: true }); }
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'installed', capabilityKind: 'editorExtension' });
		}
	}));
	return registrations;
}

function describePermission(permission: PluginPermission): string {
	switch (permission.type) {
		case 'directory': return permission.access === 'read' ? localize({ bundle: 'ash.extensions', key: 'permissionRead' }, 'Read workspace files') : localize({ bundle: 'ash.extensions', key: 'permissionWrite' }, 'Write workspace files');
		case 'process': return localize({ bundle: 'ash.extensions', key: 'permissionProcess' }, 'Run {0}', permission.executable);
		case 'network': return localize({ bundle: 'ash.extensions', key: 'permissionNetwork' }, 'Access network hosts: {0}', permission.hosts.join(', '));
	}
}


/** Resolve current authority at invocation time; rows and editors never retain a policy revision. */
export async function changeExtensionEnablement(input: ExtensionsInput, enablement: IGlobalExtensionEnablementService, management: IExtensionManagementService, plugins: IPluginService): Promise<void> {
	if (input.source === ExtensionsInputSource.BuiltIn) {
		const descriptor = (await createBrowserExtensionApi().list('cached')).extensions.find(value => value.id === input.summary.id);
		if (!descriptor) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
		const manifest = JSON.parse(descriptor.manifestJson);
		if (manifest.ashRuntime?.kind === 'rust' && !manifest.browser) {
			const catalog = await management.listBuiltInProviders();
			const provider = catalog.providers.find(value => value.id === descriptor.id);
			if (!provider) { throw new Error(localize({ bundle: 'ash.extensions', key: 'backendUnavailable' }, 'This provider is unavailable on the connected backend.')); }
			await management.setBuiltInProviderEnabled(provider.id, !provider.enabled, catalog.revision);
			return;
		}
		const extension = { id: input.summary.id };
		if (enablement.getDisabledExtensions().some(value => value.id === extension.id.toLowerCase())) { await enablement.enableExtension(extension); }
		else { await enablement.disableExtension(extension); }
		return;
	}
	if (input.source === ExtensionsInputSource.Local) {
		const catalog = await plugins.list();
		const plugin = catalog.packages.find(value => value.id === input.summary.id && value.version === input.summary.version);
		if (!plugin) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
		if (plugin.enabled) { await plugins.disable(plugin, catalog.revision); }
		else { await plugins.enable(plugin, catalog.revision); }
		return;
	}
	const catalog = await management.listEditorExtensions();
	const extension = catalog.extensions.find(value => value.installationId === input.installationId);
	if (!extension) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
	await management.setEditorExtensionPolicy(extension, extension.enabled ? 'disable' : 'enable', catalog.revision);
}

export async function reviewExtensionExecution(extension: ExtensionsEditorExtensionPolicy, management: IExtensionManagementService, dialogs: IDialogService): Promise<void> {
	const catalog = await management.listEditorExtensions();
	const selected = catalog.extensions.find(value => value.installationId === extension.installationId);
	if (!selected) { return; }
	await dialogs.prompt({
		title: selected.package.id, message: selected.package.version,
		detail: localize({ bundle: 'ash.extensions', key: 'extensionsExecutionNotice' }, 'Authorize this exact extension to run in the product Node host with your user-level filesystem, network and child-process access, including inherited developer environment variables. Editor APIs receive documents including unsaved text. Package or execution-contract changes require new authorization.'),
		buttons: [{ label: selected.granted ? localize({ bundle: 'ash.extensions', key: 'revokeExtensionsExecution' }, 'Revoke execution authorization') : localize({ bundle: 'ash.extensions', key: 'grantExtensionsExecution' }, 'Authorize execution'), run: () => management.setEditorExtensionPolicy(selected, selected.granted ? 'revoke' : 'grant', catalog.revision) }],
	});
}

export async function reviewLocalExtensionPermissions(plugin: PluginPackageView, plugins: IPluginService, dialogs: IDialogService): Promise<void> {
	const catalog = await plugins.list();
	const selected = catalog.packages.find(value => value.id === plugin.id && value.digest === plugin.digest);
	if (!selected) { return; }
	await dialogs.prompt({
		title: selected.displayName, message: `${selected.id} · ${selected.version}`,
		detail: [localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', selected.permissions.length ? selected.permissions.map(describePermission).join('; ') : localize({ bundle: 'ash.extensions', key: 'noPermissions' }, 'None')),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDocumentNotice' }, 'VS Code extensions use the product Node host with user-level filesystem, network and child-process access and inherited developer environment variables. Editor callbacks can receive unsaved text. Grant permissions only to packages you trust.'),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.digest)].join('\n\n'),
		buttons: [{ label: selected.granted ? localize({ bundle: 'ash.extensions', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.extensions', key: 'grantLocalExtension' }, 'Grant permissions'), run: () => selected.granted ? plugins.revokeGrant(selected, catalog.revision) : plugins.grant(selected, catalog.revision) }],
	});
}

export function extensionEnablementLabel(enabled: boolean): string {
	return enabled ? localize({ bundle: 'ash.extensions', key: 'disableLocalExtension' }, 'Disable') : localize({ bundle: 'ash.extensions', key: 'enableLocalExtension' }, 'Enable');
}
