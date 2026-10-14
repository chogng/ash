import { localize, localize2 } from '../../../../nls.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsEditorExtensionPolicy } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPluginManagementService, type PluginPackageView, type PluginPermission } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import { ExtensionsInputSource, type ExtensionsInput } from '../common/extensionsInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { McpServerRuntimeState } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import type { IMcpServerManagementService, McpServerConfiguration, McpServerConfigurationSnapshot } from '../../../../platform/mcp/common/mcpServerManagementService.js';

/** The dialog edits one revision-bound declaration; changing transports never changes its identity. */
export async function configureMcpServer(service: IMcpServerManagementService, dialogs: IDialogService, snapshot: McpServerConfigurationSnapshot, previous?: McpServerConfiguration, signal?: AbortSignal): Promise<string | undefined> {
	const title = previous
		? localize({ bundle: 'ash.extensions', key: 'mcpEditServer' }, 'Edit MCP server')
		: localize({ bundle: 'ash.extensions', key: 'mcpAddServer' }, 'Add MCP server');
	const choice = await dialogs.prompt<'streamableHttp' | 'stdio'>({
		title,
		message: localize({ bundle: 'ash.extensions', key: 'mcpChooseTransport' }, 'Choose how to connect to this server.'),
		buttons: [
			{ label: localize({ bundle: 'ash.extensions', key: 'mcpHttpTransport' }, 'HTTP server'), run: () => 'streamableHttp' },
			{ label: localize({ bundle: 'ash.extensions', key: 'mcpStdioTransport' }, 'Local process (stdio)'), run: () => 'stdio' },
		],
	});
	if (!choice.result || signal?.aborted) { return undefined; }
	const transport = choice.result;
	const fields = [
		...(!previous ? [{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpLocalId' }, 'Server ID'), value: '' }] : []),
		{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpDisplayName' }, 'Display name'), value: previous?.displayName ?? '' },
		...(transport === 'streamableHttp'
			? [{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpServerUrl' }, 'HTTP or HTTPS server URL'), value: previous?.transport.type === 'streamableHttp' ? previous.transport.url : '' }]
			: [
				{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpCommand' }, 'Executable path'), value: previous?.transport.type === 'stdio' ? previous.transport.command : '' },
				{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpArguments' }, 'Arguments (JSON array of strings)'), value: previous?.transport.type === 'stdio' ? JSON.stringify(previous.transport.args) : '[]' },
			]),
		{ placeholder: localize({ bundle: 'ash.extensions', key: 'mcpCredentialReference' }, 'Credential reference (optional)'), value: previous?.credential.type === 'reference' ? previous.credential.credentialRef : '' },
	];
	let enabled = previous?.enablement === 'enabled';
	let detail = localize({ bundle: 'ash.extensions', key: 'mcpConfigurationHelp' }, 'Use a unique server ID without spaces or colons. Credentials are references to stored credentials. Enabling is saved; Connect and Disconnect control this running instance.');
	for (; ;) {
		const input = await dialogs.input({
			title, message: previous ? previous.id : title, detail, inputs: fields,
			checkbox: { label: localize({ bundle: 'ash.extensions', key: 'mcpEnableServer' }, 'Enable this server'), checked: enabled },
			primaryButton: localize({ bundle: 'ash.extensions', key: 'mcpSaveServer' }, 'Save'),
		});
		if (!input.confirmed || signal?.aborted) { return undefined; }
		const values = input.values ?? [];
		for (let index = 0; index < fields.length; index++) { fields[index].value = values[index] ?? ''; }
		enabled = input.checkboxChecked ?? enabled;
		let server: McpServerConfiguration;
		try {
			let index = 0;
			const localId = previous ? undefined : values[index++]?.trim() ?? '';
			if (localId !== undefined && (!localId || /[:\s\0]/u.test(localId))) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpInvalidId' }, 'Enter a server ID without spaces or colons.'));
			}
			const id = previous?.id ?? `user:mcp:${localId}`;
			if (!previous && snapshot.servers.some(server => server.id === id)) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpDuplicateId' }, 'A server with this ID already exists. Choose another ID.'));
			}
			const displayName = values[index++]?.trim() ?? '';
			const endpoint = values[index++]?.trim() ?? '';
			if (!displayName || !endpoint || /[\r\n\0]/u.test(displayName + endpoint)) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpRequiredFields' }, 'Enter a display name and a valid server URL or executable path.'));
			}
			let args: string[] = [];
			if (transport === 'stdio') {
				const raw = values[index++] ?? '';
				let parsed: unknown;
				try { parsed = JSON.parse(raw); } catch { /* The same validation message covers malformed JSON and invalid arguments. */ }
				if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === 'string' && arg.trim() && !/[\r\n\0]/u.test(arg))) {
					throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpInvalidArguments' }, 'Arguments must be a JSON array of non-empty strings, for example ["--port", "3000"].'));
				}
				args = parsed;
			} else {
				let url: URL | undefined;
				try { url = new URL(endpoint); } catch { /* Report one localized error for an invalid HTTP endpoint. */ }
				if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
					throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpInvalidUrl' }, 'Enter an HTTP or HTTPS URL without embedded credentials.'));
				}
			}
			const credentialRef = values[index]?.trim() ?? '';
			if (/[\r\n\0]/u.test(credentialRef)) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'mcpInvalidCredential' }, 'Enter a credential reference on one line.'));
			}
			server = {
				id, displayName,
				transport: transport === 'stdio' ? { type: 'stdio', command: endpoint, args } : { type: 'streamableHttp', url: endpoint },
				credential: credentialRef ? { type: 'reference', credentialRef } : { type: 'unauthenticated' },
				enablement: enabled ? 'enabled' : 'disabled',
			};
		} catch (error) { detail = error instanceof Error ? error.message : String(error); continue; }
		await service.save(server, snapshot.revision);
		return server.id;
	}
}

export function describeMcpServerState(state: McpServerRuntimeState): string {
	switch (state.status) {
		case 'disabled': return localize({ bundle: 'ash.extensions', key: 'mcpDisabled' }, 'Disabled');
		case 'disconnected': return localize({ bundle: 'ash.extensions', key: 'mcpDisconnected' }, 'Disconnected');
		case 'connected': return localize({ bundle: 'ash.extensions', key: 'mcpConnected' }, 'Connected');
		case 'stale': return localize({ bundle: 'ash.extensions', key: 'mcpStale' }, 'Tool catalog out of date');
		case 'unavailable': return localize({ bundle: 'ash.extensions', key: 'mcpUnavailable' }, 'Unavailable');
	}
}

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
				resources.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (!item) return;
					resolve(item); picker.hide();
				}));
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
			super({ id: 'ash.extensions.installFromGit', title: localize2({ bundle: 'ash.extensions', key: 'installGitExtension' }, 'Install plugin from Git repository'), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const plugins = accessor.get(IPluginManagementService);
			const dialogs = accessor.get(IDialogService);
			const quickInput = accessor.get(IQuickInputService);
			const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
			if (folders.length === 0) {
				await dialogs.info(localize({ bundle: 'ash.extensions', key: 'gitInstallWorkspace' }, 'Open a workspace folder to install a plugin from Git.'));
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
				title: localize({ bundle: 'ash.extensions', key: 'installGitExtension' }, 'Install plugin from Git repository'),
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
			progress.ariaLabel = localize({ bundle: 'ash.extensions', key: 'gitInstallProgress' }, 'Installing plugin from Git. Press Escape to cancel.');
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
	registrations.add(registerAction2(class ManageExtensionExecution extends Action2 {
		constructor() { super({ id: 'ash.extensions.manageExtensions', title: localize2({ bundle: 'ash.extensions', key: 'manageExtensionExecution' }, 'Manage extension execution'), f1: true }); }
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'installed', capabilityKind: 'editorExtension' });
		}
	}));
	return registrations;
}

export function describePluginPermission(permission: PluginPermission): string {
	switch (permission.type) {
		case 'directory': return permission.access === 'read' ? localize({ bundle: 'ash.extensions', key: 'permissionRead' }, 'Read workspace files') : localize({ bundle: 'ash.extensions', key: 'permissionWrite' }, 'Write workspace files');
		case 'process': return localize({ bundle: 'ash.extensions', key: 'permissionProcess' }, 'Run {0}', permission.executable);
		case 'network': return localize({ bundle: 'ash.extensions', key: 'permissionNetwork' }, 'Access network hosts: {0}', permission.hosts.join(', '));
	}
}


/** Resolve current authority at invocation time; rows and editors never retain a policy revision. */
export async function changeExtensionEnablement(input: ExtensionsInput, enablement: IGlobalExtensionEnablementService, management: IExtensionManagementService, plugins: IPluginManagementService, packages: IExtensionApi): Promise<void> {
	if (input.source === ExtensionsInputSource.BuiltIn) {
		const descriptor = (await packages.list('cached', { includeDisabled: true })).extensions.find(value => value.id === input.summary.id);
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

export async function reviewLocalExtensionPermissions(plugin: PluginPackageView, plugins: IPluginManagementService, dialogs: IDialogService): Promise<void> {
	const catalog = await plugins.list();
	const selected = catalog.packages.find(value => value.id === plugin.id && value.digest === plugin.digest);
	if (!selected) { return; }
	await dialogs.prompt({
		title: selected.displayName, message: `${selected.id} · ${selected.version}`,
		detail: [localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', selected.permissions.length ? selected.permissions.map(describePluginPermission).join('; ') : localize({ bundle: 'ash.extensions', key: 'noPermissions' }, 'None')),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDocumentNotice' }, 'VS Code extensions use the product Node host with user-level filesystem, network and child-process access and inherited developer environment variables. Editor callbacks can receive unsaved text. Grant permissions only to packages you trust.'),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.digest)].join('\n\n'),
		buttons: [{ label: selected.granted ? localize({ bundle: 'ash.extensions', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.extensions', key: 'grantLocalExtension' }, 'Grant permissions'), run: () => selected.granted ? plugins.revokeGrant(selected, catalog.revision) : plugins.grant(selected, catalog.revision) }],
	});
}

export function extensionEnablementLabel(enabled: boolean): string {
	return enabled ? localize({ bundle: 'ash.extensions', key: 'disableLocalExtension' }, 'Disable') : localize({ bundle: 'ash.extensions', key: 'enableLocalExtension' }, 'Enable');
}
