import { h, type IDimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage, type ExtensionsPackageDetails } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ExtensionsInput, ExtensionsInputSource, ExtensionsCapabilityInput } from '../common/extensionsInput.js';
import { IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { createBrowserExtensionApi } from '../../../../platform/extensions/browser/extensionApi.js';
import { changeExtensionEnablement, describePluginPermission, extensionEnablementLabel, reviewExtensionExecution, reviewLocalExtensionPermissions } from './extensionsActions.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import './extensions.css';

/** Package review and mutations share the same exact-version confirmation in rows and editor. */
export async function changeExtensionPackage(service: IExtensionManagementService, dialogs: IDialogService, operation: 'install' | 'update' | 'uninstall', details: ExtensionsPackageDetails | undefined, installation?: ExtensionsInstalledPackage): Promise<ExtensionsInstalledPackage | null | undefined> {
	if (operation === 'uninstall' && installation) {
		const review = await dialogs.confirm({
			title: localize({ bundle: 'ash.extensions', key: 'uninstallTitle' }, 'Uninstall extension'),
			message: localize({ bundle: 'ash.extensions', key: 'uninstallMessage' }, 'Uninstall {0} {1}?', installation.package.id, installation.package.version),
			detail: localize({ bundle: 'ash.extensions', key: 'uninstallReview' }, 'This removes all capabilities in this package:\n{0}\nActive consumers may delay removal.', installation.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n')),
			primaryButton: localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'),
		});
		if (!review.confirmed) { return undefined; }
		await service.uninstall(installation.installationId);
		return null;
	}
	if (operation === 'update' && installation) { details = await service.get(installation.package.id); }
	if (!details) { return undefined; }
	const label = operation === 'install' ? localize({ bundle: 'ash.extensions', key: 'install' }, 'Install') : localize({ bundle: 'ash.extensions', key: 'update' }, 'Update');
	const review = await dialogs.confirm({
		title: label,
		message: localize({ bundle: 'ash.extensions', key: 'installMessage' }, '{0} {1} {2}?', label, details.displayName, details.package.version),
		detail: localize({ bundle: 'ash.extensions', key: 'installReview' }, '{0}\nSource: {1}\n{2}\nAll capabilities in this package are installed together.', details.package.id, details.source === 'official' ? localize({ bundle: 'ash.extensions', key: 'official' }, 'Official package') : localize({ bundle: 'ash.extensions', key: 'thirdParty' }, 'Third-party package'), describeExtensionCapabilities(details)),
		primaryButton: label,
	});
	if (!review.confirmed) { return undefined; }
	return operation === 'update' && installation ? service.update(installation.installationId, details.package.version) : service.install(details.package.id, details.package.version);
}

function describeExtensionCapabilities(details: ExtensionsPackageDetails): string {
	const notice = details.packageType === 'editorExtension' ? localize({ bundle: 'ash.extensions', key: 'declarativeOnly' }, 'Installation loads supported themes, syntax and snippets without running scripts. Enable or disable the whole extension in its details. JavaScript execution requires separate authorization.') : '';
	return [notice, ...details.capabilities.map(capability => `${capability.kind}: ${capability.id}${capability.permissions.length ? '\n' + localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', capability.permissions.join(', ')) : ''}`)].filter(Boolean).join('\n');
}

/** A retained editor presents package metadata while the backend owns installed state and authority. */
export class ExtensionsEditor extends EditorPane {
	public readonly id = 'ash.extensions.editor';
	private domNode!: HTMLElement;
	private title!: HTMLElement;
	private metadata!: HTMLElement;
	private description!: HTMLElement;
	private capabilities!: HTMLElement;
	private contentHeading!: HTMLElement;
	private status!: HTMLElement;
	private actions!: HTMLElement;
	private readonly actionResources = this._register(new DisposableStore());
	private loadVersion = 0;
	private working = false;
	private currentInput: ExtensionsInput | ExtensionsCapabilityInput | undefined;
	private currentSignal: AbortSignal | undefined;

	constructor(@IExtensionManagementService private readonly extensions: IExtensionManagementService,
		@IDialogService private readonly dialogs: IDialogService,
		@ICommandService private readonly commands: ICommandService,
		@IGlobalExtensionEnablementService private readonly enablement: IGlobalExtensionEnablementService,
		@IPluginManagementService private readonly plugins: IPluginManagementService,
		@IPromptsService private readonly prompts: IPromptsService,
		@IAgentCapabilitiesService private readonly agentCapabilities: IAgentCapabilitiesService,
		@IEditorService private readonly editors: IEditorService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super('ash.extensions.editor', theme, storage);
		const refresh = () => {
			if (!this.working && this.currentInput && this.currentSignal && !this.currentSignal.aborted) {
				void this.setInput(this.currentInput, this.currentSignal).catch(error => { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } });
			}
		};
		this._register(extensions.onDidChangeInstalled(refresh));
		this._register(enablement.onDidChangeEnablement(refresh));
		this._register(plugins.onDidChange(refresh));
		this._register(prompts.onDidChangeSkills(refresh));
	}

	public override create(container: HTMLElement): void {
		this.domNode = h(mainWindow.document, 'section');
		this.domNode.className = 'ash-extension-editor';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		super.create(this.domNode);
		this.title = h(mainWindow.document, 'h1');
		this.metadata = h(mainWindow.document, 'p'); this.metadata.className = 'extension-metadata';
		this.description = h(mainWindow.document, 'p');
		this.actions = h(mainWindow.document, 'div'); this.actions.className = 'extension-actions';
		this.status = h(mainWindow.document, 'p'); this.status.setAttribute('role', 'status');
		this.contentHeading = h(mainWindow.document, 'h2');
		this.capabilities = h(mainWindow.document, 'div'); this.capabilities.className = 'extension-capabilities';
		this.domNode.append(this.title, this.metadata, this.description, this.actions, this.status, this.contentHeading, this.capabilities);
		this.title.tabIndex = -1;
		const scope = this._register(this.contextKeys.createScoped(this.domNode)); scope.createKey('extensionsDetailsFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `extensions-details-${type}-${generateUuid()}`, when: ContextKeyExpr.has('extensionsDetailsFocused'),
				getProvider: () => {
					const focused = mainWindow.document.activeElement;
					if (!this.currentInput || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type }, () => type === AccessibleViewType.View ? this.domNode.textContent ?? '' : localize({ bundle: 'ash.extensions', key: 'detailsHelp' }, 'These are the selected extension, plugin, skill or MCP server details. Use Tab to reach actions and content. Skills can be enabled or disabled and their instructions opened. MCP details show registered tools and installed package metadata. Open package opens the owning package for installation and permission management.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
				},
			}));
		}
	}

	public async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof ExtensionsInput) && !(input instanceof ExtensionsCapabilityInput)) { throw new TypeError('Extensions editor requires an Extensions input'); }
		this.currentInput = input; this.currentSignal = signal;
		const version = ++this.loadVersion;
		this.actionResources.clear();
		this.title.textContent = input.getName();
		this.metadata.textContent = input instanceof ExtensionsInput ? `${input.summary.id} · ${input.summary.version}` : '';
		this.description.textContent = input instanceof ExtensionsInput ? input.summary.description : '';
		this.capabilities.textContent = '';
		this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'capabilities' }, 'Capabilities');
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		const button = (label: string, action: () => Promise<void>, enabled = true) => {
			const control = this.actionResources.add(new Button(this.actions, { label, presentation: 'secondary', enabled }));
			this.actionResources.add(control.onDidClick(() => {
				if (this.working) { return; }
				this.working = true;
				this.domNode.setAttribute('aria-busy', 'true');
				void action().catch(error => { if (!this.isDisposed && version === this.loadVersion) { this.status.textContent = error instanceof Error ? error.message : String(error); } }).finally(() => { this.working = false; if (!this.isDisposed) { this.domNode.setAttribute('aria-busy', 'false'); } });
			}));
		};
		if (input instanceof ExtensionsCapabilityInput) {
			const target = input.target;
			if (target.kind === 'skill') {
				this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'skillDetails' }, 'Skill details');
				const snapshot = await this.prompts.readSkillManagement(target.sessionId);
				if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				const skill = snapshot.catalog.skills.find(skill => skill.id.source === target.source && skill.id.name === target.name);
				if (!skill) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'skillMissing' }, 'This skill is no longer available. Refresh Skills.'); return; }
				this.metadata.textContent = localize({ bundle: 'ash.extensions', key: 'skillSource' }, 'Source: {0}', skill.id.source);
				this.description.textContent = skill.description;
				this.status.textContent = skill.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				this.capabilities.textContent = [
					skill.compatible ? localize({ bundle: 'ash.extensions', key: 'skillCompatible' }, 'Compatible') : localize({ bundle: 'ash.extensions', key: 'skillCompatibilityUnknown' }, 'Compatibility unknown'),
					localize({ bundle: 'ash.extensions', key: 'skillInvoke' }, 'Invoke enabled skills with ${0} in chat.', skill.id.name),
					...(snapshot.diagnostics.length ? snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`) : [localize({ bundle: 'ash.extensions', key: 'skillNoDiagnostics' }, 'No skill diagnostics.')]),
				].join('\n\n');
				button(skill.enabled ? localize({ bundle: 'ash.extensions', key: 'disableSkill' }, 'Disable skill') : localize({ bundle: 'ash.extensions', key: 'enableSkill' }, 'Enable skill'), async () => {
					await this.prompts.setSkillEnablement(skill.id, !skill.enabled, snapshot.revision, target.sessionId);
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); this.focus(); }
				});
				button(localize({ bundle: 'ash.extensions', key: 'openSkillInstructions' }, 'Open instructions'), async () => {
					const cancellation = new CancellationTokenSource();
					const cancel = (): void => cancellation.cancel();
					signal.addEventListener('abort', cancel, { once: true });
					this.actionResources.add(toDisposable(() => { signal.removeEventListener('abort', cancel); cancellation.dispose(true); }));
					const parsed = await this.prompts.parseNew(skill.uri, cancellation.token);
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.editors.openEditor({ resource: skill.uri, initialText: parsed.content, languageId: 'markdown', label: `${skill.name}/SKILL.md`, readOnly: true, showBreadcrumbs: false }, { pinned: true }); }
				});
				button(localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), async () => { await this.setInput(input, signal); });
				return;
			}
			this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'mcpToolsHeading' }, 'Tools');
			const installed = await this.extensions.listInstalled();
			const installation = installed.find(entry => entry.installationId === target.installationId);
			const capability = installation?.capabilities.find(entry => entry.kind === 'mcp' && entry.reference.id === target.capabilityId);
			const catalog = this.agentCapabilities.isAvailable ? await this.agentCapabilities.read() : undefined;
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const tools = catalog?.tools.filter(tool => tool.source === 'mcp' && tool.sourceDetails.includes(target.serverId)) ?? [];
			this.title.textContent = capability?.id ?? target.serverId;
			this.metadata.textContent = installation ? `${installation.package.id} · ${installation.package.version}` : target.serverId;
			this.status.textContent = tools.length ? localize({ bundle: 'ash.extensions', key: 'mcpToolsCount' }, '{0} registered tools', tools.length) : localize({ bundle: 'ash.extensions', key: 'mcpNoTools' }, 'No tools are currently registered for this server.');
			this.capabilities.textContent = [
				...(capability ? [localize({ bundle: 'ash.extensions', key: 'mcpContract' }, 'Contract version: {0}', capability.contractVersion), localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', capability.permissions.join(', '))] : []),
				...tools.map(tool => `${tool.name}\n${tool.description}`),
			].join('\n\n');
			if (installation && capability) {
				button(localize({ bundle: 'ash.extensions', key: 'openPackage' }, 'Open package'), async () => {
					await this.editors.openEditor(new ExtensionsInput({ id: installation.package.id, version: installation.package.version, displayName: installation.package.id, description: '', packageType: 'plugin' }, installation.installationId));
				});
			}
			button(localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), async () => { await this.setInput(input, signal); });
			return;
		}

		const toggle = async () => {
			await changeExtensionEnablement(input, this.enablement, this.extensions, this.plugins);
			if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); this.focus(); }
		};
		if (input.source === ExtensionsInputSource.BuiltIn) {
			const catalog = await createBrowserExtensionApi().list('cached');
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const extension = catalog.extensions.find(value => value.sourceKind === 'builtIn' && value.id === input.summary.id);
			if (!extension) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
			const manifest = JSON.parse(extension.manifestJson);
			if (manifest.ashRuntime?.kind === 'rust' && !manifest.browser) {
				const catalog = await this.extensions.listBuiltInProviders();
				if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				const provider = catalog.providers.find(value => value.id === extension.id);
				if (!provider) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'backendUnavailable' }, 'This provider is unavailable on the connected backend.'); return; }
				this.status.textContent = provider.enabled ? provider.running ? localize({ bundle: 'ash.extensions', key: 'providerRunning' }, 'Enabled · running') : localize({ bundle: 'ash.extensions', key: 'providerStopped' }, 'Enabled · starts on demand') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				this.capabilities.textContent = (manifest.ashRuntime.capabilities ?? []).join('\n');
				button(extensionEnablementLabel(provider.enabled), toggle);
				return;
			}
			const enabled = !this.enablement.getDisabledExtensions().some(value => value.id === extension.id.toLowerCase());
			this.status.textContent = enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
			this.capabilities.textContent = Object.keys(manifest.contributes ?? {}).join('\n');
			if (manifest.contributes?.localizations?.length) {
				this.status.textContent = localize({ bundle: 'ash.extensions', key: 'languagePackEnablement' }, 'Language packs are managed through the display language setting and cannot be disabled.');
			} else { button(extensionEnablementLabel(enabled), toggle); }
			return;
		}
		if (input.source === ExtensionsInputSource.Local) {
			const catalog = await this.plugins.list();
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const plugin = catalog.packages.find(value => value.id === input.summary.id && value.version === input.summary.version);
			if (!plugin) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
			this.status.textContent = plugin.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
			this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'pluginPermissionsHeading' }, 'Permissions');
			this.capabilities.textContent = [localize({ bundle: 'ash.extensions', key: 'localExtensionDigest' }, 'Package digest: {0}', plugin.digest), ...plugin.permissions.map(describePluginPermission)].join('\n\n');
			button(extensionEnablementLabel(plugin.enabled), toggle, plugin.enabled || !plugin.revoked);
			button(plugin.granted ? localize({ bundle: 'ash.extensions', key: 'revokeLocalExtension' }, 'Revoke permissions') : localize({ bundle: 'ash.extensions', key: 'grantLocalExtension' }, 'Grant permissions'), async () => { await reviewLocalExtensionPermissions(plugin, this.plugins, this.dialogs); if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); } }, plugin.granted || !plugin.revoked);
			button(localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'), async () => {
				const review = await this.dialogs.confirm({ title: localize({ bundle: 'ash.extensions', key: 'uninstallTitle' }, 'Uninstall extension'), message: localize({ bundle: 'ash.extensions', key: 'uninstallMessage' }, 'Uninstall {0} {1}?', plugin.id, plugin.version), primaryButton: localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall') });
				if (!review.confirmed) { return; }
				const latest = await this.plugins.list();
				const selected = latest.packages.find(value => value.id === plugin.id && value.digest === plugin.digest);
				if (!selected) { return; }
				await this.plugins.uninstall(selected, latest.revision);
				if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				this.clearInput(); this.actions.replaceChildren();
				this.status.textContent = localize({ bundle: 'ash.extensions', key: 'uninstalled' }, 'Uninstalled');
			}, !plugin.enabled && !plugin.granted);
			return;
		}
		const installed = await this.extensions.listInstalled();
		if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
		const installation = installed.find(entry => input.installationId ? entry.installationId === input.installationId : entry.package.id === input.summary.id && entry.package.version === input.summary.version);
		// Installed operations remain available even if every registry is offline.
		const details = await this.extensions.get(input.summary.id, input.summary.version).catch(error => {
			if (!installation) { throw error; }
			return undefined;
		});
		if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
		this.title.textContent = details?.displayName ?? input.summary.displayName;
		this.description.textContent = details?.description ?? input.summary.description;
		this.metadata.textContent = [input.summary.id, input.summary.version, details?.license].filter(Boolean).join(' · ');
		this.capabilities.textContent = details ? describeExtensionCapabilities(details) : installation?.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n') ?? '';
		const hasInstalled = installed.some(entry => entry.package.id === input.summary.id);
		this.status.textContent = installation?.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : hasInstalled ? localize({ bundle: 'ash.extensions', key: 'installed' }, 'Installed · activation is separate') : '';

		const mutate = async (operation: 'install' | 'update' | 'uninstall') => {
			const result = await changeExtensionPackage(this.extensions, this.dialogs, operation, details, installation);
			if (result !== undefined && !this.isDisposed && version === this.loadVersion) {
				const nextInput = result ? new ExtensionsInput({ ...input.summary, version: result.package.version }, result.installationId) : input;
				try { await this.setInput(nextInput, signal); } finally { if (nextInput !== input) { nextInput.dispose(); } }
			}
		};
		if (installation) {
			button(localize({ bundle: 'ash.extensions', key: 'update' }, 'Update'), () => mutate('update'), installation.state === 'installed');
			button(localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'), () => mutate('uninstall'), installation.state === 'installed');
		} else if (!hasInstalled) { button(localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'), () => mutate('install'), !!details); }
		if (installation && installation.state === 'installed') {
			const catalog = await this.extensions.listEditorExtensions();
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const policy = catalog.extensions.find(value => value.installationId === installation.installationId);
			if (policy) {
				this.status.textContent = policy.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				button(extensionEnablementLabel(policy.enabled), async () => {
					using target = new ExtensionsInput(input.summary, installation.installationId);
					await changeExtensionEnablement(target, this.enablement, this.extensions, this.plugins);
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); this.focus(); }
				});
				if (policy.entrypoint !== null || policy.granted) {
					button(policy.granted ? localize({ bundle: 'ash.extensions', key: 'revokeExtensionsExecution' }, 'Revoke execution authorization') : localize({ bundle: 'ash.extensions', key: 'grantExtensionsExecution' }, 'Authorize execution'), async () => { await reviewExtensionExecution(policy, this.extensions, this.dialogs); if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); } });
				}
			}
		}
		if (hasInstalled) { button(localize({ bundle: 'ash.extensions', key: 'showInstalled' }, 'Show installed versions'), () => this.commands.executeCommand('ash.extensions.installed', { query: input.summary.id })); }
	}

	public clearInput(): void { this.currentInput = undefined; this.currentSignal = undefined; ++this.loadVersion; this.actionResources.clear(); }
	public layout(_dimension: IDimension): void { }
	public focus(): void { (this.actions.querySelector<HTMLButtonElement>('button') ?? this.title).focus(); }
}

registerEditorPane({
	id: 'ash.extensions.editor', name: 'Extensions',
	canOpen: input => (input instanceof ExtensionsInput || input instanceof ExtensionsCapabilityInput) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Extensions editor requires the Instantiation Service'); }
		return options.instantiationService.createInstance(ExtensionsEditor);
	},
});
