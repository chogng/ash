import { localize, localize2 } from '../../../../nls.js';
import type { SkillDescriptor } from '../../../../platform/agentHost/common/appServerApi.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, type ExtensionsEditorExtensionPolicy } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPluginManagementService, type PluginPackageView, type PluginPermission } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import { ExtensionsInputSource, type ExtensionsInput, type ExtensionsCapabilityTarget } from '../common/extensionsInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionIgnoredRecommendationsService, IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { IExtensionRecommendationNotificationService } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { McpServerRuntimeState } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import type { ConnectorState, IConnectorService } from '../../../../platform/connectors/common/connectorService.js';
import type { IMcpServerManagementService, McpServerConfiguration, McpServerConfigurationSnapshot } from '../../../../platform/mcp/common/mcpServerManagementService.js';

/** The sidebar and detail header share the same concise, localized Skill description. */
export function getSkillSummary(skill: SkillDescriptor): string {
	if (skill.id.source === 'builtin:skill-source:ash-release') {
		if (skill.id.name === 'create-instructions') {
			return localize({ bundle: 'ash.extensions', key: 'skillCreateInstructionsSummary' }, 'Create and update Ash project instructions.');
		}
		if (skill.id.name === 'skill-creator') {
			return localize({ bundle: 'ash.extensions', key: 'skillCreatorSummary' }, 'Create and update Ash skills.');
		}
	}
	const description = (skill.metadata?.['short-description'] || skill.description).replace(/\s+/gu, ' ').trim();
	return description.match(/^.*?(?:[。！？]|[.!?](?:\s|$))/u)?.[0].trim() ?? description;
}

/** Selection uses the catalog's actions; account and server mutations stay with their domain owners. */
export async function addConnection(connectors: IConnectorService, mcp: IMcpServerManagementService, quickInput: IQuickInputService, dialogs: IDialogService, signal: AbortSignal): Promise<ExtensionsCapabilityTarget | undefined> {
	const title = localize({ bundle: 'ash.extensions', key: 'addConnection' }, 'Add connection');
	const choice = await pickExtensionItem<IQuickPickItem & { readonly kind: 'account' | 'mcp'; }>(quickInput, title,
		mcp.isAvailable
			? localize({ bundle: 'ash.extensions', key: 'connectionChooseKind' }, 'How would you like to connect?')
			: localize({ bundle: 'ash.extensions', key: 'connectionAccountOnlyHelp' }, 'Sign in to a supported service. Custom MCP configuration is unavailable in this window.'),
		[
			{ label: localize({ bundle: 'ash.extensions', key: 'connectionAccount' }, 'Service account'), kind: 'account', detail: localize({ bundle: 'ash.extensions', key: 'connectionServiceHelp' }, 'Sign in to a supported service or authorize with an API token.') },
			...(mcp.isAvailable ? [{ label: localize({ bundle: 'ash.extensions', key: 'connectionCustomMcp' }, 'Custom MCP server'), kind: 'mcp' as const, detail: localize({ bundle: 'ash.extensions', key: 'connectionCustomMcpHelp' }, 'Connect external tools using a server URL or a local command.') }] : []),
		], signal);
	if (!choice || signal.aborted) { return undefined; }
	if (choice.kind === 'mcp') {
		const snapshot = await mcp.readConfiguration();
		if (signal.aborted) { return undefined; }
		const serverId = await configureMcpServer(mcp, dialogs, snapshot, undefined, signal);
		return serverId ? { kind: 'mcp', serverId } : undefined;
	}
	const catalog = await connectors.list();
	if (signal.aborted) { return undefined; }
	if (!catalog.connectors.length) {
		await dialogs.info(
			localize({ bundle: 'ash.extensions', key: 'connectionNoAccounts' }, 'No service accounts are available.'),
			localize({ bundle: 'ash.extensions', key: 'connectionInstallAccount' }, 'Install a plugin that provides a service account, then add a connection again.'),
		);
		return undefined;
	}
	const selected = await pickExtensionItem(quickInput,
		localize({ bundle: 'ash.extensions', key: 'connectionChooseService' }, 'Choose a service account'),
		localize({ bundle: 'ash.extensions', key: 'connectionSearchServices' }, 'Search services to sign in or authorize with an API token'),
		catalog.connectors.map(connector => ({ label: connector.displayName, description: describeConnectorState(connector.state, connector.enabled), detail: connector.description, connector })), signal);
	if (!selected || signal.aborted) { return undefined; }
	// Selection can outlive a catalog update. Use fresh permissions and a matching generation for authorization.
	const current = await connectors.list();
	if (signal.aborted) { return undefined; }
	const connector = current.connectors.find(entry => entry.id === selected.connector.id);
	if (!connector) { throw new Error(localize({ bundle: 'ash.extensions', key: 'connectorMissing' }, 'This connection is no longer available. Refresh Connections.')); }
	if (!connector.canConnectOAuth && !connector.canConnectApiToken) {
		await dialogs.info(connector.displayName, [describeConnectorState(connector.state, connector.enabled), connector.state.status === 'unavailable' ? connector.state.reason : ''].filter(Boolean).join('\n\n'));
		return { kind: 'connector', connectorId: connector.id };
	}
	const authorization = await dialogs.prompt<'oauth' | 'token'>({
		title: connector.displayName,
		message: localize({ bundle: 'ash.extensions', key: 'connectionChooseAuthorization' }, 'Choose how to authorize {0}.', connector.displayName),
		detail: connector.description,
		buttons: [
			...(connector.canConnectOAuth ? [{ label: localize({ bundle: 'ash.extensions', key: 'mcpSignIn' }, 'Sign in'), run: () => 'oauth' as const }] : []),
			...(connector.canConnectApiToken ? [{ label: localize({ bundle: 'ash.extensions', key: 'connectorConnectToken' }, 'Connect with API token'), run: () => 'token' as const }] : []),
		],
	});
	if (!authorization.result || signal.aborted) { return undefined; }
	if (authorization.result === 'oauth') {
		await connectors.connectOAuth(connector, current.generation);
	} else {
		const input = await promptConnectorApiToken(dialogs, connector.displayName);
		if (!input || signal.aborted) { return undefined; }
		await connectors.connectApiToken(connector, current.generation, input);
	}
	return { kind: 'connector', connectorId: connector.id };
}

async function pickExtensionItem<T extends IQuickPickItem>(quickInput: IQuickInputService, label: string, placeholder: string, items: readonly T[], signal: AbortSignal): Promise<T | undefined> {
	using resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<T>());
	picker.ariaLabel = label;
	picker.placeholder = placeholder;
	picker.items = items;
	return await new Promise<T | undefined>(resolve => {
		resources.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) { return; }
			resolve(item);
			picker.hide();
		}));
		resources.add(picker.onDidHide(() => resolve(undefined)));
		resources.add(picker.onDidBlur(() => picker.hide()));
		const abort = () => { resolve(undefined); picker.hide(); };
		signal.addEventListener('abort', abort, { once: true });
		resources.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		picker.show();
	});
}

/** Shared credential boundary for the add flow and account details. Never retain a token in view state. */
export async function promptConnectorApiToken(dialogs: IDialogService, displayName: string): Promise<{ readonly accountId: string; readonly accountDisplayName: string; readonly token: string; } | undefined> {
	const result = await dialogs.input({
		title: displayName,
		message: localize({ bundle: 'ash.extensions', key: 'connectorTokenPrompt' }, 'Enter the account and API token for this connection.'),
		inputs: [
			{ placeholder: localize({ bundle: 'ash.extensions', key: 'connectorAccountId' }, 'Account ID') },
			{ placeholder: localize({ bundle: 'ash.extensions', key: 'connectorAccountName' }, 'Account name') },
			{ type: 'password', placeholder: localize({ bundle: 'ash.extensions', key: 'connectorApiToken' }, 'API token') },
		],
		primaryButton: localize({ bundle: 'ash.extensions', key: 'mcpConnect' }, 'Connect'),
	});
	if (!result.confirmed) { return undefined; }
	const [accountId, accountDisplayName, token] = result.values ?? [];
	if (!accountId?.trim() || !accountDisplayName?.trim() || !token?.trim()) { throw new Error(localize({ bundle: 'ash.extensions', key: 'connectorTokenRequired' }, 'Enter an account ID, account name and API token.')); }
	return { accountId: accountId.trim(), accountDisplayName: accountDisplayName.trim(), token };
}

/** The dialog edits one revision-bound declaration; changing transports never changes its identity. */
export async function configureMcpServer(service: IMcpServerManagementService, dialogs: IDialogService, snapshot: McpServerConfigurationSnapshot, previous?: McpServerConfiguration, signal?: AbortSignal): Promise<string | undefined> {
	const title = previous
		? localize({ bundle: 'ash.extensions', key: 'mcpEditServer' }, 'Edit MCP server')
		: localize({ bundle: 'ash.extensions', key: 'addConnection' }, 'Add connection');
	const httpLabel = localize({ bundle: 'ash.extensions', key: 'mcpHttpTransport' }, 'HTTP server');
	const stdioLabel = localize({ bundle: 'ash.extensions', key: 'mcpStdioTransport' }, 'Local process (stdio)');
	const choice = await dialogs.prompt<'streamableHttp' | 'stdio'>({
		title,
		message: localize({ bundle: 'ash.extensions', key: 'mcpChooseTransport' }, 'Choose a connection method.'),
		detail: localize({ bundle: 'ash.extensions', key: 'mcpTransportHelp' }, 'MCP servers provide external tools. Use {0} for a service URL, or {1} to run a server on this computer.', httpLabel, stdioLabel),
		buttons: [
			{ label: httpLabel, run: () => 'streamableHttp' },
			{ label: stdioLabel, run: () => 'stdio' },
		],
	});
	if (!choice.result || signal?.aborted) { return undefined; }
	const transport = choice.result;
	const methodLabel = transport === 'streamableHttp' ? httpLabel : stdioLabel;
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
			title, message: previous ? previous.id : localize({ bundle: 'ash.extensions', key: 'connectionConfigureMethod' }, 'Configure {0}.', methodLabel), detail, inputs: fields,
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

export function describeConnectorState(state: ConnectorState, enabled = true): string {
	if (!enabled && state.status === 'connected') { return localize({ bundle: 'ash.extensions', key: 'mcpDisconnected' }, 'Disconnected'); }
	switch (state.status) {
		case 'disconnected': return localize({ bundle: 'ash.extensions', key: 'mcpDisconnected' }, 'Disconnected');
		case 'connecting': return localize({ bundle: 'ash.extensions', key: 'connectorConnecting' }, 'Connecting');
		case 'connected': return localize({ bundle: 'ash.extensions', key: 'connectorAccountConnected' }, 'Connected · {0}', state.account.displayName);
		case 'unavailable': return localize({ bundle: 'ash.extensions', key: 'mcpUnavailable' }, 'Unavailable');
		case 'reauthorizationRequired': return localize({ bundle: 'ash.extensions', key: 'connectorReauthorization' }, 'Sign in again · {0}', state.account.displayName);
	}
}

/** Both product windows use the same source, package and execution operations. */
export function registerExtensionManagementActions(): DisposableStore {
	const registrations = new DisposableStore();
	const extensionsTitle = ContextKeyExpr.equals('viewContainer', 'ash.extensions');
	registrations.add(registerAction2(class ShowRecommendedKeymaps extends Action2 {
		constructor() { super({ id: 'ash.extensions.showRecommendedKeymaps', title: localize2({ bundle: 'ash.extensions', key: 'showRecommendedKeymaps' }, 'Show recommended keymaps'), f1: true, menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '2_recommendations', order: 4 } }); }
		public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { query: '@recommended keymap' }); }
	}));
	for (const undo of [false, true]) {
		registrations.add(registerAction2(class ConfigureIgnoredRecommendation extends Action2 {
			constructor() {
				super({
					id: undo ? 'ash.extensions.undoIgnoreRecommendation' : 'ash.extensions.ignoreRecommendation',
					title: undo ? localize2({ bundle: 'ash.extensions', key: 'restoreRecommendation' }, 'Restore an ignored extension recommendation') : localize2({ bundle: 'ash.extensions', key: 'ignoreRecommendation' }, 'Ignore an extension recommendation'),
					f1: true, menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '2_recommendations', order: undo ? 2 : 1 },
				});
			}
			public override async run(accessor: ServicesAccessor): Promise<void> {
				const recommendations = accessor.get(IExtensionRecommendationsService);
				const ignored = accessor.get(IExtensionIgnoredRecommendationsService);
				const quick = accessor.get(IQuickInputService);
				const items = undo ? ignored.globalIgnoredRecommendations.map(id => ({ label: id, id })) : (await recommendations.getRecommendations()).recommendations.map(item => ({ label: item.extensionId, description: item.reason.reasonText, id: item.extensionId }));
				const selected = await pickExtensionItem(quick, localize({ bundle: 'ash.extensions', key: 'recommendedPane' }, 'Recommended'), undo ? localize({ bundle: 'ash.extensions', key: 'restoreRecommendationPick' }, 'Choose a recommendation to restore. Workspace exclusions are edited in the workspace configuration.') : localize({ bundle: 'ash.extensions', key: 'ignoreRecommendationPick' }, 'Choose an extension to hide from recommendations in this profile.'), items, new AbortController().signal);
				if (selected) { ignored.toggleGlobalIgnoredRecommendation(selected.id, !undo); }
			}
		}));
	}
	registrations.add(registerAction2(class RestoreRecommendationNotifications extends Action2 {
		constructor() {
			super({ id: 'ash.extensions.resetRecommendationNotifications', title: localize2({ bundle: 'ash.extensions', key: 'restoreRecommendationNotifications' }, 'Restore dismissed extension recommendation notifications'), f1: true, menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '2_recommendations', order: 3 } });
		}
		public override run(accessor: ServicesAccessor): void {
			accessor.get(IExtensionRecommendationNotificationService).resetIgnoredRecommendations();
			accessor.get(IExtensionRecommendationsService).refresh();
		}
	}));
	for (const marketplace of [true, false]) {
		registrations.add(registerAction2(class SwitchExtensionsPresentation extends Action2 {
			constructor() {
				super({
					id: marketplace ? 'ash.extensions.browse' : 'ash.extensions.showInstalled',
					title: marketplace ? localize2({ bundle: 'ash.extensions', key: 'browseMarketplace' }, 'Browse Marketplace') : localize2({ bundle: 'ash.extensions', key: 'showInstalledResources' }, 'Show installed'),
					icon: marketplace ? Lxicon.search : Lxicon.arrowLeft,
					f1: true,
					menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '1_discovery', order: marketplace ? 1 : 2 },
				});
			}
			public override async run(accessor: ServicesAccessor): Promise<void> {
				await accessor.get(ICommandService).executeCommand(marketplace ? OPEN_EXTENSIONS_COMMAND_ID : OPEN_INSTALLED_EXTENSIONS_COMMAND_ID, marketplace ? { mode: 'browse' } : undefined);
			}
		}));
	}
	registrations.add(registerAction2(class ManageBuiltInExtensions extends Action2 {
		constructor() {
			super({
				id: 'ash.extensions.manageBuiltIn',
				get title() { return localize2({ bundle: 'ash.extensions', key: 'manageBuiltInExtensions' }, 'Manage built-in editor extensions'); },
				f1: true,
				menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '1_discovery', order: 3 },
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { mode: 'builtIn' });
		}
	}));
	registrations.add(registerAction2(class ManageExtensionSources extends Action2 {
		constructor() {
			super({
				id: 'ash.extensions.manageSources',
				title: localize2({ bundle: 'ash.extensions', key: 'manageSources' }, 'Manage extension sources'),
				f1: true,
				menu: { id: MenuId.ViewContainerTitle, when: extensionsTitle, group: '2_sources', order: 1 },
			});
		}
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
					description: localize({ bundle: 'ash.extensions', key: 'ashSource' }, 'Ash open source'),
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
export async function changeExtensionEnablement(input: ExtensionsInput, enablement: IGlobalExtensionEnablementService, management: IExtensionManagementService, plugins: IPluginManagementService, packages: IExtensionApi, options: { readonly enabled?: boolean; } = {}): Promise<void> {
	const enabled = options.enabled;
	if (input.source === ExtensionsInputSource.BuiltIn) {
		const descriptor = (await packages.list('cached', { includeDisabled: true })).extensions.find(value => value.id === input.summary.id);
		if (!descriptor) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
		const manifest = JSON.parse(descriptor.manifestJson);
		if ((manifest.ashRuntime?.kind === 'rust' && !manifest.browser) || !!manifest.ashLanguageServers) {
			const catalog = await management.listBuiltInProviders();
			if (!catalog.canChangeEnablement) {
				throw new Error(localize({ bundle: 'ash.extensions', key: 'providerEnablementReadOnly' }, 'This connection cannot enable or disable backend providers. Use an authorized desktop or remote host to manage this provider.'));
			}
			const provider = catalog.providers.find(value => value.id === descriptor.id);
			if (!provider) { throw new Error(localize({ bundle: 'ash.extensions', key: 'backendUnavailable' }, 'This provider is unavailable on the connected backend.')); }
			await management.setBuiltInProviderEnabled(provider.id, enabled ?? !provider.enabled, catalog.revision);
			return;
		}
		const extension = { id: input.summary.id };
		if (enabled ?? enablement.getDisabledExtensions().some(value => value.id === extension.id.toLowerCase())) { await enablement.enableExtension(extension); }
		else { await enablement.disableExtension(extension); }
		return;
	}
	if (input.source === ExtensionsInputSource.Local) {
		const catalog = await plugins.list();
		const plugin = catalog.packages.find(value => value.id === input.summary.id && value.version === input.summary.version);
		if (!plugin) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
		const nextEnabled = enabled ?? !plugin.enabled;
		if (nextEnabled) { await plugins.enable(plugin, catalog.revision); }
		else { await plugins.disable(plugin, catalog.revision); }
		return;
	}
	const catalog = await management.listEditorExtensions();
	const extension = catalog.extensions.find(value => value.installationId === input.installationId);
	if (!extension) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
	await management.setEditorExtensionPolicy(extension, (enabled ?? !extension.enabled) ? 'enable' : 'disable', catalog.revision);
}

export async function reviewExtensionExecution(extension: ExtensionsEditorExtensionPolicy, management: IExtensionManagementService, dialogs: IDialogService): Promise<void> {
	const catalog = await management.listEditorExtensions();
	const selected = catalog.extensions.find(value => value.installationId === extension.installationId);
	if (!selected) { return; }
	await dialogs.prompt({
		title: selected.package.id, message: selected.package.version,
		detail: selected.executionKind === 'native'
			? localize({ bundle: 'ash.extensions', key: 'nativeExtensionsExecutionNotice' }, 'Authorize this exact extension to run its native program and trusted editor client with your user-level filesystem, network and child-process access. The editor client receives document content, including unsaved text. Package or execution-contract changes require new authorization.')
			: localize({ bundle: 'ash.extensions', key: 'extensionsExecutionNotice' }, 'Authorize this exact extension to run in the product Node host with your user-level filesystem, network and child-process access, including inherited developer environment variables. Editor APIs receive documents including unsaved text. Package or execution-contract changes require new authorization.'),
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
		localize({ bundle: 'ash.extensions', key: 'localExtensionDocumentNotice' }, 'Ash extensions use the product Node host with user-level filesystem, network and child-process access and inherited developer environment variables. Editor callbacks can receive unsaved text. Grant permissions only to packages you trust.'),
		localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', selected.digest)].join('\n\n'),
		buttons: [{ label: selected.granted ? localize({ bundle: 'ash.extensions', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.extensions', key: 'grantLocalExtension' }, 'Grant permissions'), run: () => selected.granted ? plugins.revokeGrant(selected, catalog.revision) : plugins.grant(selected, catalog.revision) }],
	});
}

export function extensionEnablementLabel(enabled: boolean): string {
	return enabled ? localize({ bundle: 'ash.extensions', key: 'disableLocalExtension' }, 'Disable') : localize({ bundle: 'ash.extensions', key: 'enableLocalExtension' }, 'Enable');
}
