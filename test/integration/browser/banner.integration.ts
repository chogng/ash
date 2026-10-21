import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { IAgentCapabilitiesService } from '../../../src/ash/platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IWorkspaceTrustApi, READ_DIR_PERMISSIONS, DEVELOPMENT_DIR_PERMISSIONS, type WorkspaceTrustPermission } from '../../../src/ash/platform/workspace/common/workspaceTrust.js';
import settingsChinese from '../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import '../../../src/ash/base/browser/ui/styles.css';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/workbench/contrib/remote/browser/remote.contribution.js';
import '../../../src/ash/workbench/contrib/workspace/browser/workspace.contribution.js';
import '../../../src/ash/workbench/contrib/accessibility/browser/accessibility.contribution.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { Dimension } from '../../../src/ash/base/browser/dom.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { MarkdownString } from '../../../src/ash/base/common/htmlContent.js';
import { setNlsMessages, formatNlsMessage } from '../../../src/ash/nls.js';
import { IAppServerApi, type IAppServerConnectionRecovery } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IContextViewService, IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IHoverService, HoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../src/ash/platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IWorkspaceTrustManagementService, type IWorkspaceTrustInfo } from '../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { WorkbenchState } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkbenchLayout } from '../../../src/ash/workbench/browser/layout.js';
import { Part } from '../../../src/ash/workbench/browser/part.js';
import { BannerPart } from '../../../src/ash/workbench/browser/parts/banner/bannerPart.js';
import { IBannerService } from '../../../src/ash/workbench/services/banner/browser/bannerService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IWorkbenchLayoutService, workbenchPartIds, type WorkbenchPartId } from '../../../src/ash/workbench/services/layout/browser/layoutService.js';
import { AccessibleViewService } from '../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { bindTestColorTheme } from './themeFixture.js';
import chinese from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
if (new URLSearchParams(location.search).has('zh')) setNlsMessages('zh-CN', chinese);
const root = document.querySelector<HTMLElement>('#app')!;
resources.add(setARIAContainer(root));
const baseServices = resources.add(createTestEditorServices());
const services = resources.add(baseServices.createChild());
const workspace = resources.add(new TestWorkspaceService({ id: 'first', uri: URI.file('/first') }));
services.registerInstance(IWorkspaceContextService, workspace);
const theme = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, theme);
resources.add(bindTestColorTheme(theme, root));
const dialogs = resources.add(new DialogService());
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(root)));
services.registerInstance(IDialogService, dialogs);
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (bundle, key, fallback, parameters) => formatNlsMessage(new URLSearchParams(location.search).has('zh') ? (settingsChinese as Record<string, Record<string, string>>)[bundle]?.[key] ?? fallback : fallback, parameters) });
const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);
services.registerInstance(ICodeEditorService, resources.add(new StandaloneCodeEditorService()));
services.registerInstance(IOpenerService, resources.add(services.createInstance(OpenerService)));
services.registerInstance(IMarkdownRendererService, services.createInstance(MarkdownRendererService));
const layout = resources.add(services.createInstance(WorkbenchLayout, root, { workbenchState: WorkbenchState.FOLDER, initialDimension: new Dimension(innerWidth, innerHeight), focus: () => draft.focus() }));
services.registerInstance(IWorkbenchLayoutService, layout);
const contextView = resources.add(new BrowserContextViewService(root, layout));
services.registerInstance(IContextViewService, contextView);
const contextMenu = { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } } as const;
services.registerInstance(IContextMenuService, contextMenu);
services.registerInstance(IHoverService, resources.add(new HoverService(services.get(IConfigurationService), contextView, contextMenu)));
services.registerInstance(INotificationService, resources.add(new NotificationService()));
const profile = new UserDataProfileService();
services.registerInstance(IUserDataProfileService, profile);
const files = resources.add(new FileService());
resources.add(files.registerProvider(profile.currentProfile.keybindingsResource.scheme, resources.add(new InMemoryFileSystemProvider())));
await files.createDirectory(profile.currentProfile.location);
await files.writeFile({ resource: profile.currentProfile.keybindingsResource, content: '[]' }, { create: true, overwrite: true });
services.registerInstance(IFileService, files);
const keyboardLayout = resources.add(new BrowserKeyboardLayoutService({ navigator }));
const keybindings = resources.add(services.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document, commandService: commands,
	contextKeyService: services.get(IContextKeyService), keyboardLayoutService: keyboardLayout,
}));
await keybindings.initialize();
services.registerInstance(IKeybindingService, keybindings);
const accessible = resources.add(services.createInstance(AccessibleViewService));
services.registerInstance(IAccessibleViewService, accessible);
const banner = resources.add(services.createInstance(BannerPart, root, (visible: boolean) => {
	if (visible) layout.showPart('banner');
	else layout.hidePart('banner');
}));
services.registerInstance(IBannerService, banner);
const draft = document.createElement('textarea');
draft.setAttribute('aria-label', 'Editor draft');
class ContentPart extends Part {
	constructor(private readonly partId: WorkbenchPartId) {
		super(root, partId, theme, services.get(IStorageService));
		if (partId === 'editor') this.contentDomNode.append(draft);
		if (partId === 'sidebar') {
			const filter = document.createElement('input');
			filter.setAttribute('aria-label', 'Sidebar filter');
			this.contentDomNode.append(filter);
		}
	}
	override get minimumHeight(): number { return this.partId === 'titlebar' || this.partId === 'statusbar' ? 28 : 0; }
	override get maximumHeight(): number { return this.partId === 'titlebar' || this.partId === 'statusbar' ? 28 : Infinity; }
}
layout.createParts(new Map(workbenchPartIds.map(id => [id, id === 'banner' ? banner : resources.add(new ContentPart(id))])));
layout.layout(new Dimension(innerWidth, innerHeight));
window.addEventListener('resize', () => layout.layout(new Dimension(innerWidth, innerHeight)));
const changed = resources.add(new Emitter<void>());
let retries = 0;
let managementMode = false;
let managementAllowed = true;
let revision = 1;
let connectionGeneration = 1;
let grantWrites = 0;
let effectiveKnown = true;
let granted: readonly WorkspaceTrustPermission[] = READ_DIR_PERMISSIONS;
let savedPermissions: readonly WorkspaceTrustPermission[] = granted;

const recovery: IAppServerConnectionRecovery & { status: IAppServerConnectionRecovery['status']; } = {
	status: 'idle', error: 'Authorization expired', onDidChange: changed.event,
	reconnect: async () => {
		retries++; recovery.status = 'recovering'; changed.fire();
		if (managementMode) {
			await Promise.resolve();
			granted = savedPermissions;
			permissionInfo = { isTrusted: DEVELOPMENT_DIR_PERMISSIONS.every(permission => granted.includes(permission)), isReadOnly: granted.length === READ_DIR_PERMISSIONS.length && READ_DIR_PERMISSIONS.every(permission => granted.includes(permission)) };
			recovery.status = 'idle'; changed.fire(); permissionChanges.fire();
		}
	},
};
services.registerInstance(IAppServerApi, { get connectionGeneration() { return connectionGeneration; }, getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }), recovery });
const permissionChanges = resources.add(new Emitter<void>());
let permissionInfo: IWorkspaceTrustInfo | undefined;
services.registerInstance(IWorkspaceTrustManagementService, {
	onDidChangeTrust: permissionChanges.event,
	getWorkspaceTrustInfo: async () => permissionInfo,
	getUriTrustInfo: async uri => ({ uri, trusted: permissionInfo?.isTrusted ?? false, permissions: effectiveKnown ? granted : undefined }),
});
services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, onDidChange: Event.None, read: async () => ({ directoryGrantsReadable: managementAllowed, localProcessSandboxConfigured: false, sandboxBackends: [], sandboxDiagnostics: [] }) });
services.registerInstance(IWorkspaceTrustApi, {
	onDidChangeTrust: permissionChanges.event,
	readWorkspaceDirectory: async () => granted,
	readDirectory: async path => ({ dir: path, permissions: savedPermissions }),
	listDirectories: async () => ({ revision, entries: [{ dir: workspace.getWorkspace().folders[0]!.uri.fsPath, path: workspace.getWorkspace().folders[0]!.uri.fsPath, permissions: savedPermissions }] }),
	setDirectoryPermissions: async (path, permissions, expectedRevision) => {
		if (!managementAllowed || expectedRevision !== revision) throw new Error('Directory grant revision conflict');
		if (path !== workspace.getWorkspace().folders[0]!.uri.fsPath) throw new Error('Wrong workspace path');
		grantWrites++; savedPermissions = permissions; revision++; permissionChanges.fire();
		return { revision, generation: 1, disposition: 'updated' };
	},
	forgetDirectory: async () => { throw new Error('Not used'); }, createGrant: async () => { throw new Error('Not used'); }, persistGrant: async () => { throw new Error('Not used'); },
});
let trustPane: EditorPane | undefined;
services.registerInstance(IEditorService, {
	async openEditor(input) {
		managementMode = true;
		if (!trustPane) {
			const descriptor = EditorPanes.getEditorPane(input)!;
			trustPane = resources.add(await descriptor.create({ instantiationService: services }));
			const host = document.createElement('div');
			root.querySelector('[data-part="editor"]')!.append(host);
			trustPane.create(host);
		}
		await trustPane.setInput(input, new AbortController().signal);
		trustPane.layout(new Dimension(800, 560)); trustPane.focus();
	},
} as IEditorService);
const contribution = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.appServerRecovery', 'workbench.contrib.workspacePermissionStatus']));
contribution.advance(WorkbenchPhase.AfterRestored);
let closed = 0;
window.ashBannerIntegration = {
	setRecovery(status) { recovery.status = status; changed.fire(); },
	setPermissions(mode) {
		effectiveKnown = mode !== 'unknown';
		permissionInfo = mode === 'unknown' ? undefined : { isTrusted: mode === 'trusted', isReadOnly: mode === 'readonly' };
		granted = mode === 'trusted' ? DEVELOPMENT_DIR_PERMISSIONS : mode === 'readonly' ? READ_DIR_PERMISSIONS : [...READ_DIR_PERMISSIONS, 'executeCommands'];
		savedPermissions = granted;
		permissionChanges.fire();
	},
	setManagementAllowed(value) { managementAllowed = value; },
	conflictGrant() { revision++; },
	bumpConnection() { connectionGeneration++; changed.fire(); },
	managementState: () => ({ grantWrites, saved: [...savedPermissions], path: workspace.getWorkspace().folders[0]!.uri.fsPath }),
	layoutTrustEditor: (width, height) => trustPane?.layout(new Dimension(width, height)),
	async switchWorkspace(id) {
		await (services.get(IStorageService) as BrowserStorageService).switchWorkspace(id);
		workspace.updateWorkspace({ id, uri: URI.file(`/${id}`) });
		permissionChanges.fire();
	},
	setBannerPolicy: policy => services.get(IConfigurationService).updateValue('security.workspace.trust.banner', policy),
	show(id, message, priority = 0, markdown = false) { banner.show({ id, icon: undefined, message: markdown ? new MarkdownString(message) : message, priority, onClose: () => { closed++; } }); },
	hide: id => banner.hide(id),
	focus: () => commands.executeCommand('workbench.action.focusBanner'),
	command: (id: string) => commands.executeCommand(id),
	async setBindings(bindings) {
		const files = services.get(IFileService);
		await files.createDirectory(profile.currentProfile.location);
		await files.writeFile({ resource: profile.currentProfile.keybindingsResource, content: JSON.stringify(bindings) }, { create: true, overwrite: true });
		await keybindings.initialize();
	},
	openHelp: () => accessible.show(AccessibleViewType.Help),
	openView: () => accessible.show(AccessibleViewType.View),
	setTheme: index => theme.setColorTheme([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme][index]!),
	rebuild: () => layout.setSideBarLocation('right'),
	state: () => ({ retries, closed, offset: layout.mainContainerOffset.top }),
	dispose: () => resources.dispose(),
};
declare global {
	interface Window {
		ashBannerIntegration: {
			setRecovery(status: IAppServerConnectionRecovery['status']): void;
			setManagementAllowed(value: boolean): void;
			conflictGrant(): void;
			bumpConnection(): void;
			managementState(): { grantWrites: number; saved: string[]; path: string; };
			layoutTrustEditor(width: number, height: number): void;
			setPermissions(mode: 'trusted' | 'readonly' | 'restricted' | 'unknown'): void;
			switchWorkspace(id: string): Promise<void>;
			setBannerPolicy(policy: 'always' | 'untilDismissed' | 'never'): Promise<void>;
			show(id: string, message: string, priority?: number, markdown?: boolean): void;
			hide(id: string): void;
			focus(): Promise<unknown>;
			command(id: string): Promise<unknown>;
			setBindings(bindings: readonly { key: string; command: string; when?: string; }[]): Promise<void>;
			openHelp(): boolean;
			openView(): boolean;
			setTheme(index: number): void;
			rebuild(): void;
			state(): { retries: number; closed: number; offset: number; };
			dispose(): void;
		};
	}
}
