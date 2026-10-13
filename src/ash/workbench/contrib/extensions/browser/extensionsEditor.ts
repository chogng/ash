import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { Range } from '../../../../editor/common/core/range.js';
import { createObjectUrl } from '../../../../base/browser/fileAccess.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage, type ExtensionsPackageDetails } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ExtensionsInput, ExtensionsInputSource, ExtensionsCapabilityInput } from '../common/extensionsInput.js';
import { IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../../platform/extensionManagement/common/pluginManagementService.js';
import { IExtensionApi, type ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import { toExtensionResourceURI } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { changeExtensionEnablement, describeMcpServerState, describePluginPermission, extensionEnablementLabel, reviewExtensionExecution, reviewLocalExtensionPermissions } from './extensionsActions.js';
import type { ParsedPromptFile } from '../../chat/common/promptSyntax/promptFileParser.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IMcpServerStatusService } from '../../../../platform/mcp/common/mcpServerStatusService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import './media/extensionEditor.css';

enum DetailTab { Details = 'details', Features = 'features', Instructions = 'instructions' }

interface DetailInfoSection {
	readonly label: string;
	readonly rows: readonly { readonly label: string; readonly value: string; }[];
}

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
	private icon!: HTMLElement;
	private iconImage!: HTMLImageElement;
	private iconText!: HTMLElement;
	private publisher!: HTMLElement;
	private tabs!: TabList<DetailTab>;
	private readonly tabPrefix = generateUuid();
	private selectedTab = DetailTab.Details;
	private featuresLabel = '';
	private hasInstructions = false;
	private readonly panels = new Map<DetailTab, HTMLElement>();
	private overviewHeading!: HTMLElement;
	private overview!: HTMLElement;
	private readme!: HTMLElement;
	private instructions!: HTMLElement;
	private info!: HTMLElement;
	private links!: HTMLElement;
	private instructionsLoader: (() => Promise<void>) | undefined;
	private instructionsPending: Promise<void> | undefined;
	private readonly documentResources = this._register(new DisposableStore());
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
		@IMcpServerStatusService private readonly mcpStatus: IMcpServerStatusService,
		@IEditorService private readonly editors: IEditorService,
		@IExtensionApi private readonly editorExtensions: IExtensionApi,
		@IOpenerService private readonly opener: IOpenerService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
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
		const header = h(mainWindow.document, 'header'); header.className = 'extension-detail-header';
		this.icon = h(mainWindow.document, 'div'); this.icon.className = 'extension-detail-icon'; this.icon.setAttribute('aria-hidden', 'true');
		this.iconText = h(mainWindow.document, 'span');
		this.iconImage = h(mainWindow.document, 'img'); this.iconImage.alt = ''; this.iconImage.hidden = true;
		this.icon.append(this.iconText, this.iconImage);
		this._register(addDisposableListener(this.iconImage, 'error', () => { this.iconImage.hidden = true; this.iconText.hidden = false; }));
		const heading = h(mainWindow.document, 'div'); heading.className = 'extension-detail-heading';
		this.title = h(mainWindow.document, 'h1');
		this.publisher = h(mainWindow.document, 'p'); this.publisher.className = 'extension-detail-publisher'; this.publisher.hidden = true;
		this.metadata = h(mainWindow.document, 'p'); this.metadata.className = 'extension-metadata';
		this.description = h(mainWindow.document, 'p');
		this.actions = h(mainWindow.document, 'div'); this.actions.className = 'extension-actions';
		this.status = h(mainWindow.document, 'p'); this.status.setAttribute('role', 'status');
		this.contentHeading = h(mainWindow.document, 'h2');
		this.capabilities = h(mainWindow.document, 'div'); this.capabilities.className = 'extension-capabilities';
		heading.append(this.title, this.publisher, this.metadata, this.description, this.actions, this.status);
		header.append(this.icon, heading);
		const tabHost = h(mainWindow.document, 'div'); tabHost.className = 'extension-detail-tabs';
		this.tabs = this._register(new TabList<DetailTab>(tabHost, { ariaLabel: localize({ bundle: 'ash.extensions', key: 'detailTabs' }, 'Extension details'), presentation: 'flush', onActivate: tab => this.selectTab(tab) }));
		const body = h(mainWindow.document, 'div'); body.className = 'extension-detail-body';
		const article = h(mainWindow.document, 'div'); article.className = 'extension-detail-content';
		for (const tab of [DetailTab.Details, DetailTab.Features, DetailTab.Instructions]) {
			const panel = h(mainWindow.document, 'section'); panel.id = `${this.tabPrefix}-${tab}-panel`; panel.tabIndex = 0;
			panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `${this.tabPrefix}-${tab}-tab`);
			this.panels.set(tab, panel); article.append(panel);
		}
		this.overviewHeading = h(mainWindow.document, 'h2'); this.overview = h(mainWindow.document, 'p');
		this.readme = h(mainWindow.document, 'div'); this.readme.className = 'extension-detail-document';
		this.panels.get(DetailTab.Details)!.append(this.overviewHeading, this.overview, this.readme);
		this.panels.get(DetailTab.Features)!.append(this.contentHeading, this.capabilities);
		this.instructions = this.panels.get(DetailTab.Instructions)!;
		this.info = h(mainWindow.document, 'aside'); this.info.className = 'extension-detail-info'; this.info.setAttribute('aria-label', localize({ bundle: 'ash.extensions', key: 'detailInformation' }, 'Additional information'));
		this.links = h(mainWindow.document, 'div'); this.links.className = 'extension-detail-links';
		body.append(article, this.info);
		this.domNode.append(header, tabHost, body);
		const resize = new ResizeObserver(entries => { const target = entries[0]?.target; if (target) { this.layout(target.getBoundingClientRect()); } });
		resize.observe(this.domNode); this._register(toDisposable(() => resize.disconnect()));
		this.title.tabIndex = -1;
		const scope = this._register(this.contextKeys.createScoped(this.domNode)); scope.createKey('extensionsDetailsFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `extensions-details-${type}-${generateUuid()}`, when: ContextKeyExpr.has('extensionsDetailsFocused'),
				getProvider: () => {
					const focused = mainWindow.document.activeElement;
					if (!this.currentInput || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type }, () => type === AccessibleViewType.View ? this.domNode.innerText : localize({ bundle: 'ash.extensions', key: 'detailsHelp' }, 'These are the selected extension, plugin, skill or MCP server details. The header contains identity and actions. Use Tab to reach the tabs, then Left and Right to move and Enter to select. Details shows the description or README; other tabs show features, permissions, tools or skill instructions and diagnostics. Additional information is beside the content and moves below it in a narrow editor. Open package opens the owning package for installation and permission management. MCP server details show backend connection status and diagnostics. Refresh reloads server status.'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
				},
			}));
		}
	}

	public async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof ExtensionsInput) && !(input instanceof ExtensionsCapabilityInput)) { throw new TypeError('Extensions editor requires an Extensions input'); }
		if (!this.currentInput?.matches(input)) { this.selectedTab = DetailTab.Details; }
		this.currentInput = input; this.currentSignal = signal;
		const version = ++this.loadVersion;
		this.actionResources.clear();
		this.documentResources.clear(); this.readme.replaceChildren(); this.instructions.replaceChildren(); this.instructionsLoader = undefined; this.instructionsPending = undefined;
		this.iconImage.removeAttribute('src'); this.iconImage.hidden = true; this.iconText.hidden = false;
		this.title.textContent = input.getName();
		this.iconText.textContent = [...input.getName()].slice(0, 2).join('').toUpperCase();
		this.publisher.textContent = ''; this.publisher.hidden = true;
		this.metadata.textContent = input instanceof ExtensionsInput ? `${input.summary.id} · ${input.summary.version}` : '';
		this.description.textContent = input instanceof ExtensionsInput ? input.summary.description : '';
		this.renderOverview();
		this.featuresLabel = input instanceof ExtensionsCapabilityInput ? input.target.kind === 'skill' ? localize({ bundle: 'ash.extensions', key: 'detailDiagnostics' }, 'Diagnostics') : localize({ bundle: 'ash.extensions', key: 'mcpToolsHeading' }, 'Tools') : input.source === ExtensionsInputSource.Local ? localize({ bundle: 'ash.extensions', key: 'pluginPermissionsHeading' }, 'Permissions') : localize({ bundle: 'ash.extensions', key: 'detailFeatures' }, 'Features');
		this.hasInstructions = input instanceof ExtensionsCapabilityInput && input.target.kind === 'skill'; this.renderTabs();
		this.renderInfo([{
			label: localize({ bundle: 'ash.extensions', key: 'detailInstallation' }, 'Installation'), rows: input instanceof ExtensionsInput ? [
				{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: input.summary.id },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailVersion' }, 'Version'), value: input.summary.version },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailSource' }, 'Source'), value: input.source === ExtensionsInputSource.BuiltIn ? localize({ bundle: 'ash.extensions', key: 'builtInFilter' }, 'Built-in') : input.source === ExtensionsInputSource.Local ? localize({ bundle: 'ash.extensions', key: 'localPlugin' }, 'Local plugin') : localize({ bundle: 'ash.extensions', key: 'detailRegistry' }, 'Extensions registry') },
			] : [{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: input.target.kind === 'skill' ? input.target.name : input.target.serverId }]
		}]);
		this.capabilities.textContent = '';
		this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'capabilities' }, 'Capabilities');
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		const button = (label: string, action: () => Promise<void>, enabled = true, presentation: 'primary' | 'secondary' = 'secondary') => {
			const control = this.actionResources.add(new Button(this.actions, { label, presentation, enabled }));
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
				this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'detailDiagnostics' }, 'Diagnostics');
				const snapshot = await this.prompts.readSkillManagement(target.sessionId);
				if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				const skill = snapshot.catalog.skills.find(skill => skill.id.source === target.source && skill.id.name === target.name);
				if (!skill) { this.status.textContent = localize({ bundle: 'ash.extensions', key: 'skillMissing' }, 'This skill is no longer available. Refresh Skills.'); return; }
				this.metadata.textContent = localize({ bundle: 'ash.extensions', key: 'skillSource' }, 'Source: {0}', skill.id.source);
				this.description.textContent = skill.description;
				this.renderOverview();
				this.renderInfo([{
					label: localize({ bundle: 'ash.extensions', key: 'skillDetails' }, 'Skill details'), rows: [
						{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: skill.id.name },
						{ label: localize({ bundle: 'ash.extensions', key: 'detailSource' }, 'Source'), value: skill.id.source },
						{ label: localize({ bundle: 'ash.extensions', key: 'detailCompatibility' }, 'Compatibility'), value: skill.compatible ? localize({ bundle: 'ash.extensions', key: 'skillCompatible' }, 'Compatible') : localize({ bundle: 'ash.extensions', key: 'skillCompatibilityUnknown' }, 'Compatibility unknown') },
					]
				}]);
				this.status.textContent = skill.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				this.capabilities.textContent = [
					skill.compatible ? localize({ bundle: 'ash.extensions', key: 'skillCompatible' }, 'Compatible') : localize({ bundle: 'ash.extensions', key: 'skillCompatibilityUnknown' }, 'Compatibility unknown'),
					localize({ bundle: 'ash.extensions', key: 'skillInvoke' }, 'Invoke enabled skills with ${0} in chat.', skill.id.name),
					...(snapshot.diagnostics.length ? snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`) : [localize({ bundle: 'ash.extensions', key: 'skillNoDiagnostics' }, 'No skill diagnostics.')]),
				].join('\n\n');
				this.instructionsLoader = async () => {
					this.instructions.textContent = localize({ bundle: 'ash.extensions', key: 'detailInstructionsLoading' }, 'Loading skill instructions…');
					const cancellation = new CancellationTokenSource();
					const cancel = (): void => cancellation.cancel();
					signal.addEventListener('abort', cancel, { once: true });
					this.actionResources.add(toDisposable(() => { signal.removeEventListener('abort', cancel); cancellation.dispose(true); }));
					const parsed = await this.prompts.parseNew(skill.uri, cancellation.token);
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { this.renderDocument(this.instructions, parsed.body?.getContent() ?? '', { prompt: parsed }); }
				};
				if (this.selectedTab === DetailTab.Instructions) { this.selectTab(DetailTab.Instructions); }
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
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) {
						await this.editors.openEditor({ resource: skill.uri, languageId: 'markdown', label: `${skill.name}/SKILL.md`, readOnly: true, showBreadcrumbs: false }, {
							pinned: true, selection: parsed.body ? Range.fromPositions(parsed.body.range.getStartPosition()) : undefined,
						});
					}
				});
				button(localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), async () => { await this.setInput(input, signal); });
				return;
			}
			this.contentHeading.textContent = localize({ bundle: 'ash.extensions', key: 'mcpToolsHeading' }, 'Tools');
			const [installedResult, statusResult, catalogResult] = await Promise.allSettled([
				this.extensions.listInstalled(),
				this.mcpStatus.isAvailable ? this.mcpStatus.read() : Promise.resolve(undefined),
				this.agentCapabilities.isAvailable ? this.agentCapabilities.read() : Promise.resolve(undefined),
			]);
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const installed = installedResult.status === 'fulfilled' ? installedResult.value : [];
			const installation = installed.find(entry => entry.installationId === target.installationId);
			const capability = installation?.capabilities.find(entry => entry.kind === 'mcp' && entry.reference.id === target.capabilityId);
			const snapshot = statusResult.status === 'fulfilled' ? statusResult.value : undefined;
			const server = snapshot?.servers.find(server => server.id === target.serverId);
			const statusLabel = server ? describeMcpServerState(server.state) : snapshot
				? localize({ bundle: 'ash.extensions', key: 'mcpStatusNotReported' }, 'No runtime status reported')
				: localize({ bundle: 'ash.extensions', key: 'mcpStatusUnavailable' }, 'MCP server status is unavailable.');
			const diagnostic = statusResult.status === 'rejected'
				? localize({ bundle: 'ash.extensions', key: 'mcpStatusReadFailed' }, 'Could not load MCP server status: {0}', String(statusResult.reason))
				: server?.state.status === 'unavailable' ? server.state.reason : '';
			const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : undefined;
			const tools = catalog?.tools.filter(tool => tool.source === 'mcp' && tool.sourceDetails.includes(target.serverId)) ?? [];
			this.title.textContent = server?.displayName || capability?.id || target.serverId;
			this.metadata.textContent = installation ? `${installation.package.id} · ${installation.package.version}` : target.serverId;
			this.description.textContent = localize({ bundle: 'ash.extensions', key: 'detailMcpDescription' }, 'Tools provided by {0}.', this.title.textContent);
			this.renderOverview();
			this.renderInfo([{
				label: localize({ bundle: 'ash.extensions', key: 'detailServer' }, 'Server'), rows: [
					{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: target.serverId },
					{ label: localize({ bundle: 'ash.extensions', key: 'mcpState' }, 'Status'), value: statusLabel },
					{ label: localize({ bundle: 'ash.extensions', key: 'mcpDiagnostic' }, 'Diagnostic'), value: diagnostic },
					{ label: localize({ bundle: 'ash.extensions', key: 'mcpOrigin' }, 'HTTP origin'), value: server?.httpOrigin ?? '' },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailPackage' }, 'Package'), value: installation?.package.id ?? '' },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailVersion' }, 'Version'), value: installation?.package.version ?? '' },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailContract' }, 'Contract version'), value: capability?.contractVersion ?? '' },
					{ label: localize({ bundle: 'ash.extensions', key: 'mcpToolsHeading' }, 'Tools'), value: server ? String(server.toolCount) : '' },
				]
			}]);
			this.status.textContent = [statusLabel, diagnostic,
				installedResult.status === 'rejected' ? localize({ bundle: 'ash.extensions', key: 'mcpPackagesReadFailed' }, 'Could not load installed packages: {0}', String(installedResult.reason)) : '',
			].filter(Boolean).join(' · ');
			this.capabilities.textContent = [
				...(capability ? [localize({ bundle: 'ash.extensions', key: 'mcpContract' }, 'Contract version: {0}', capability.contractVersion), localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', capability.permissions.join(', '))] : []),
				catalogResult.status === 'rejected' ? localize({ bundle: 'ash.extensions', key: 'mcpToolsReadFailed' }, 'Could not load tool descriptions: {0}', String(catalogResult.reason)) : '',
				server?.toolCount === 0 ? localize({ bundle: 'ash.extensions', key: 'mcpNoTools' }, 'No tools are currently registered for this server.') : '',
				...tools.map(tool => `${tool.name}\n${tool.description}`),
			].filter(Boolean).join('\n\n');
			if (installation && capability) {
				button(localize({ bundle: 'ash.extensions', key: 'openPackage' }, 'Open package'), async () => {
					await this.editors.openEditor(new ExtensionsInput({ id: installation.package.id, version: installation.package.version, displayName: installation.package.id, description: '', packageType: 'plugin' }, installation.installationId));
				});
			}
			button(localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), async () => {
				await this.setInput(input, signal);
				if (!signal.aborted && !this.isDisposed && this.currentInput === input) { this.focus(); }
			});
			return;
		}

		const toggle = async () => {
			await changeExtensionEnablement(input, this.enablement, this.extensions, this.plugins, this.editorExtensions);
			if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); this.focus(); }
		};
		if (input.source === ExtensionsInputSource.BuiltIn) {
			const catalog = await this.editorExtensions.list('cached', { includeDisabled: true });
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const extension = catalog.extensions.find(value => value.sourceKind === 'builtIn' && value.id === input.summary.id);
			if (!extension) { throw new Error(localize({ bundle: 'ash.extensions', key: 'extensionMissing' }, 'This extension is no longer installed. Refresh Extensions.')); }
			const manifest = JSON.parse(extension.manifestJson);
			void this.loadPackageDocument(input, signal, version);
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
			this.renderInfo([{
				label: localize({ bundle: 'ash.extensions', key: 'detailInstallation' }, 'Installation'), rows: [
					{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: plugin.id },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailVersion' }, 'Version'), value: plugin.version },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailSource' }, 'Source'), value: localize({ bundle: 'ash.extensions', key: 'localPlugin' }, 'Local plugin') },
					{ label: localize({ bundle: 'ash.extensions', key: 'detailDigest' }, 'Package digest'), value: plugin.digest },
				]
			}]);
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
		this.renderOverview();
		this.renderInfo([{
			label: localize({ bundle: 'ash.extensions', key: 'detailInstallation' }, 'Installation'), rows: [
				{ label: localize({ bundle: 'ash.extensions', key: 'detailIdentifier' }, 'Identifier'), value: input.summary.id },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailVersion' }, 'Version'), value: input.summary.version },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailLicense' }, 'License'), value: details?.license ?? '' },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailSource' }, 'Source'), value: details ? details.source === 'official' ? localize({ bundle: 'ash.extensions', key: 'official' }, 'Official package') : localize({ bundle: 'ash.extensions', key: 'thirdParty' }, 'Third-party package') : '' },
				{ label: localize({ bundle: 'ash.extensions', key: 'detailDigest' }, 'Package digest'), value: installation?.package.digest ?? '' },
			]
		}]);
		if (input.summary.packageType === 'editorExtension') { void this.loadPackageDocument(input, signal, version); }
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
			button(localize({ bundle: 'ash.extensions', key: 'update' }, 'Update'), () => mutate('update'), installation.state === 'installed', 'primary');
			button(localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'), () => mutate('uninstall'), installation.state === 'installed');
		} else if (!hasInstalled) { button(localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'), () => mutate('install'), !!details, 'primary'); }
		if (installation && installation.state === 'installed') {
			const catalog = await this.extensions.listEditorExtensions();
			if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
			const policy = catalog.extensions.find(value => value.installationId === installation.installationId);
			if (policy) {
				this.status.textContent = policy.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled');
				button(extensionEnablementLabel(policy.enabled), async () => {
					using target = new ExtensionsInput(input.summary, installation.installationId);
					await changeExtensionEnablement(target, this.enablement, this.extensions, this.plugins, this.editorExtensions);
					if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); this.focus(); }
				});
				if (policy.entrypoint !== null || policy.granted) {
					button(policy.granted ? localize({ bundle: 'ash.extensions', key: 'revokeExtensionsExecution' }, 'Revoke execution authorization') : localize({ bundle: 'ash.extensions', key: 'grantExtensionsExecution' }, 'Authorize execution'), async () => { await reviewExtensionExecution(policy, this.extensions, this.dialogs); if (!signal.aborted && !this.isDisposed && version === this.loadVersion) { await this.setInput(input, signal); } });
				}
			}
		}
		if (hasInstalled) { button(localize({ bundle: 'ash.extensions', key: 'showInstalled' }, 'Show installed versions'), () => this.commands.executeCommand('ash.extensions.installed', { query: input.summary.id })); }
	}

	private renderOverview(): void {
		this.overviewHeading.hidden = false; this.overview.hidden = false;
		this.overviewHeading.textContent = localize({ bundle: 'ash.extensions', key: 'detailAbout' }, 'About');
		this.overview.textContent = this.description.textContent;
	}

	private renderTabs(): void {
		const tabs = [{ id: DetailTab.Details, label: localize({ bundle: 'ash.extensions', key: 'detailDetails' }, 'Details') }, { id: DetailTab.Features, label: this.featuresLabel }];
		if (this.hasInstructions) { tabs.splice(1, 0, { id: DetailTab.Instructions, label: localize({ bundle: 'ash.extensions', key: 'detailInstructions' }, 'Instructions') }); }
		if (!tabs.some(tab => tab.id === this.selectedTab)) { this.selectedTab = DetailTab.Details; }
		this.tabs.setTabs(tabs.map(tab => ({ ...tab, value: tab.id, tabId: `${this.tabPrefix}-${tab.id}-tab`, panelId: `${this.tabPrefix}-${tab.id}-panel`, ariaDescription: this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Extensions) ? localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.') : undefined })), this.selectedTab);
		for (const [tab, panel] of this.panels) { panel.hidden = tab !== this.selectedTab; }
	}

	private selectTab(tab: DetailTab): void {
		this.selectedTab = tab; this.renderTabs();
		if (tab === DetailTab.Instructions && this.instructionsLoader && !this.instructionsPending && !this.instructions.querySelector('.ash-markdown')) {
			const version = this.loadVersion;
			this.instructionsPending = this.instructionsLoader().catch(error => { if (!this.isDisposed && version === this.loadVersion) { this.instructions.textContent = error instanceof Error ? error.message : String(error); } }).finally(() => { if (version === this.loadVersion) { this.instructionsPending = undefined; } });
		}
	}

	private renderInfo(sections: readonly DetailInfoSection[]): void {
		this.info.replaceChildren(); this.links.replaceChildren();
		for (const section of sections) {
			const container = h(mainWindow.document, 'section'); container.className = 'extension-info-section';
			const heading = h(mainWindow.document, 'h2'); heading.textContent = section.label;
			const list = h(mainWindow.document, 'dl');
			for (const row of section.rows.filter(row => row.value)) {
				const term = h(mainWindow.document, 'dt'); term.textContent = row.label;
				const value = h(mainWindow.document, 'dd'); value.textContent = row.value;
				list.append(term, value);
			}
			container.append(heading, list); this.info.append(container);
		}
		this.links.hidden = true; this.info.append(this.links);
	}

	private addResourceLink(label: string, action: () => Promise<void>): void {
		if (this.links.hidden) {
			this.links.hidden = false;
			const heading = h(mainWindow.document, 'h2'); heading.textContent = localize({ bundle: 'ash.extensions', key: 'detailResources' }, 'Resources'); this.links.append(heading);
		}
		const link = h(mainWindow.document, 'a'); link.href = '#'; link.textContent = label; this.links.append(link);
		this.documentResources.add(addDisposableListener(link, 'click', event => {
			event.preventDefault();
			const version = this.loadVersion;
			void action().catch(error => { if (!this.isDisposed && version === this.loadVersion) { this.status.textContent = error instanceof Error ? error.message : String(error); } });
		}));
	}

	private renderDocument(container: HTMLElement, markdown: string, source?: { readonly resource: URI; readonly api: IExtensionApi; } | { readonly prompt: ParsedPromptFile; }): void {
		const version = this.loadVersion;
		const document = this.documentResources.add(this.markdownRenderer.render({ value: markdown, isTrusted: false, supportHtml: true }, {
			ownerDocument: mainWindow.document,
			sanitizerConfig: { allowedLinkSchemes: { augment: ['ash-extension-resource', ...(source && 'prompt' in source ? ['private'] : [])] }, remoteImageIsAllowed: () => false },
			transformUri: source ? href => 'prompt' in source ? source.prompt.body?.resolveFilePath(href)?.toString() ?? href : /^[a-z][a-z\d+.-]*:/iu.test(href) ? href : URI.joinPath(source.resource, '..', href).toString() : undefined,
			imageResourceLoader: source && 'api' in source ? async resource => new Blob([new Uint8Array(await source.api.resources.readExtensionResourceBytes(resource))]) : undefined,
			actionHandler: href => { void this.opener.open(href, { allowCommands: false, fromUserGesture: true, allowContributedOpeners: true }).catch(error => { if (!this.isDisposed && version === this.loadVersion) { this.status.textContent = String(error); } }); },
		}));
		container.replaceChildren(document.element);
	}

	private async loadPackageDocument(input: ExtensionsInput, signal: AbortSignal, version: number): Promise<void> {
		const api = this.editorExtensions;
		let descriptor: ExtensionDescriptor | undefined;
		let manifest: Record<string, unknown>;
		let resourceFor: (path: string) => Promise<URI | undefined>;
		try {
			const catalog = await api.list('cached', { includeDisabled: input.source === ExtensionsInputSource.BuiltIn });
			const id = input.summary.id.replace(/@open-vsx$/u, '');
			descriptor = catalog.extensions.find(extension => extension.id === id && extension.version === input.summary.version);
			if (descriptor) {
				const generation = catalog.generation; const extensionId = descriptor.id;
				resourceFor = async path => toExtensionResourceURI({ generation, extensionId, path });
				manifest = JSON.parse(descriptor.manifestJson);
			} else {
				if (input.source !== ExtensionsInputSource.Registry || !input.summary.id.endsWith('@open-vsx')) { return; }
				const separator = id.indexOf('.');
				if (separator < 1) { return; }
				const identity = { publisher: id.slice(0, separator), name: id.slice(separator + 1), version: input.summary.version };
				resourceFor = path => api.resources.getExtensionGalleryResourceURL(identity, path);
				const resource = await resourceFor('package.json');
				if (!resource) { return; }
				manifest = JSON.parse(await api.resources.readExtensionResource(resource));
			}
			if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { return; }
		} catch { return; }
		if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
		const publisher = descriptor?.publisher ?? (typeof manifest.publisher === 'string' ? manifest.publisher : '');
		this.publisher.textContent = publisher; this.publisher.hidden = !publisher;
		if (Array.isArray(manifest.categories) && manifest.categories.length && manifest.categories.every(category => typeof category === 'string')) {
			const section = h(mainWindow.document, 'section'); section.className = 'extension-info-section';
			const heading = h(mainWindow.document, 'h2'); heading.textContent = localize({ bundle: 'ash.extensions', key: 'detailCategories' }, 'Categories');
			const categories = h(mainWindow.document, 'div'); categories.className = 'extension-info-categories';
			for (const category of manifest.categories) { const label = h(mainWindow.document, 'span'); label.textContent = category; categories.append(label); }
			section.append(heading, categories); this.info.insertBefore(section, this.links);
		}
		if (typeof manifest.homepage === 'string' && /^https?:\/\//iu.test(manifest.homepage)) {
			const homepage = manifest.homepage;
			this.addResourceLink(localize({ bundle: 'ash.extensions', key: 'detailHomepage' }, 'Homepage'), async () => { await this.opener.open(homepage, { openExternal: true, allowCommands: false, fromUserGesture: true }); });
		}
		const readme = async (): Promise<void> => {
			for (const path of ['README.md', 'readme.md']) {
				try {
					const resource = await resourceFor(path);
					if (!resource || signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
					const markdown = await api.resources.readExtensionResource(resource);
					if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
					this.renderDocument(this.readme, markdown, { resource, api }); this.overviewHeading.hidden = true; this.overview.hidden = true;
					this.addResourceLink('README.md', () => this.editors.openEditor({ resource, initialText: markdown, languageId: 'markdown', label: `${input.summary.displayName}/README.md`, readOnly: true, showBreadcrumbs: false }, { pinned: true }));
					return;
				} catch { /* A package without a README uses its catalog description. */ }
			}
		};
		const icon = async (): Promise<void> => {
			if (typeof manifest.icon !== 'string' || !/\.(?:png|jpe?g|gif|webp|svg)$/iu.test(manifest.icon)) { return; }
			try {
				const resource = await resourceFor(manifest.icon);
				if (!resource || signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				const bytes = await api.resources.readExtensionResourceBytes(resource);
				if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
				const mime = manifest.icon.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : `image/${manifest.icon.split('.').at(-1)!.toLowerCase().replace('jpg', 'jpeg')}`;
				const object = createObjectUrl(mainWindow, new Blob([new Uint8Array(bytes)], { type: mime })); this.documentResources.add(object.registration);
				this.iconImage.src = object.url.toString(); this.iconImage.hidden = false; this.iconText.hidden = true;
			} catch { /* Retain the package initials when its icon cannot be loaded. */ }
		};
		await Promise.allSettled([readme(), icon()]);
	}

	public clearInput(): void { this.currentInput = undefined; this.currentSignal = undefined; ++this.loadVersion; this.actionResources.clear(); this.documentResources.clear(); this.instructionsLoader = undefined; this.instructionsPending = undefined; }
	public layout(dimension: IDimension): void { this.domNode.classList.toggle('compact', dimension.width < 720); }
	public focus(): void {
		const target = this.actions.querySelector<HTMLButtonElement>('button') ?? this.title;
		if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Extensions)) { target.setAttribute('aria-description', localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.')); } else { target.removeAttribute('aria-description'); }
		target.focus();
	}
}

registerEditorPane({
	id: 'ash.extensions.editor', name: localize({ bundle: 'ash.extensions', key: 'extensionList' }, 'Extensions'),
	canOpen: input => (input instanceof ExtensionsInput || input instanceof ExtensionsCapabilityInput) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Extensions editor requires the Instantiation Service'); }
		return options.instantiationService.createInstance(ExtensionsEditor);
	},
});
