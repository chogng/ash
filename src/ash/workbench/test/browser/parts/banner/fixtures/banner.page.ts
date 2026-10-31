import { WorkspaceTrustManagementService, WorkspaceTrustRequestService } from '../../../../../services/workspaces/common/workspaceTrust.js';
import { IRemoteAuthorityResolverService } from '../../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { EditorPanes } from '../../../../../browser/editor.js';
import type { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { IAgentCapabilitiesService } from '../../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import { IDialogsModel } from '../../../../../common/dialogs.js';
import { BrowserDialogHandler } from '../../../../../browser/parts/dialogs/dialog.js';
import { NativeDialogHandler } from '../../../../../electron-browser/parts/dialogs/dialogHandler.js';
import type { INativeHostApi } from '../../../../../../platform/native/common/nativeHost.js';
import { ITerminalService } from '../../../../../contrib/terminal/browser/terminal.js';
import { IDebugService } from '../../../../../contrib/debug/common/debug.js';
import { DialogHandlerContribution } from '../../../../../browser/parts/dialogs/dialog.web.contribution.js';
import { ILocalizationService } from '../../../../../services/localization/common/localizationService.js';
import { IWorkspaceTrustApi, READ_DIR_PERMISSIONS, RESTRICTED_DIR_PERMISSIONS, DEVELOPMENT_DIR_PERMISSIONS, type WorkspaceTrustPermission } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import settingsChinese from '../../../../../../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import '../../../../../contrib/remote/browser/remote.contribution.js';
import '../../../../../contrib/workspace/browser/workspace.contribution.js';
import '../../../../../contrib/accessibility/browser/accessibility.contribution.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { Dimension } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { setNlsMessages, formatNlsMessage } from '../../../../../../nls.js';
import { IAppServerApi, type IAppServerConnectionRecovery } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextViewService, IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { IHoverService, HoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { BrowserKeyboardLayoutService } from '../../../../../services/keybinding/browser/keyboardLayoutService.js';
import { WorkbenchKeybindingService } from '../../../../../services/keybinding/browser/keybindingService.js';
import { IUserDataProfileService } from '../../../../../services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../../services/userDataProfile/browser/userDataProfileService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import { OpenerService } from '../../../../../../editor/browser/services/openerService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { URI } from '../../../../../../base/common/uri.js';
import { WorkbenchState } from '../../../../../../platform/workspace/common/workspace.js';
import { WorkbenchLayout } from '../../../../../browser/layout.js';
import { Part } from '../../../../../browser/part.js';
import { WorkbenchWindowBarHeight } from '../../../../../browser/parts/workbenchPartDimensions.js';
import { BannerPart } from '../../../../../browser/parts/banner/bannerPart.js';
import { IBannerService } from '../../../../../services/banner/browser/bannerService.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { IWorkbenchLayoutService, workbenchPartIds, type WorkbenchPartId } from '../../../../../services/layout/browser/layoutService.js';
import { AccessibleViewService } from '../../../../../contrib/accessibility/browser/accessibleView.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../common/contributions.js';
import { createTestEditorServices } from '../../../../common/testEditorServices.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import chinese from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

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
const dialogHandler = new URLSearchParams(location.search).has('native')
	? new NativeDialogHandler({ showMessageBox: async () => { throw new Error('Workspace Trust must use a workbench dialog'); } } as unknown as INativeHostApi, root)
	: new BrowserDialogHandler(root);
resources.add(new DialogHandlerContribution(dialogs.model, dialogHandler));
services.registerInstance(IDialogService, dialogs);
services.registerInstance(IDialogsModel, dialogs.model);
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
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
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
	override get minimumHeight(): number { return this.partId === 'titlebar' ? WorkbenchWindowBarHeight : this.partId === 'statusbar' ? 28 : 0; }
	override get maximumHeight(): number { return this.partId === 'titlebar' || this.partId === 'statusbar' ? this.minimumHeight : Infinity; }
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
const trustResponses: string[] = [];
let effectiveKnown = true;
let granted: readonly WorkspaceTrustPermission[] = DEVELOPMENT_DIR_PERMISSIONS;
let savedPermissions: readonly WorkspaceTrustPermission[] = granted;
let runningSessions: 'none' | 'terminal' | 'debug' | 'exited' = 'none';
// Trust presentation observes session lifetimes without launching real processes in this fixture.
services.registerInstance(ITerminalService, { get instances() { return runningSessions === 'terminal' ? [{ state: 'running' }] : runningSessions === 'exited' ? [{ state: 'exited' }] : []; } } as unknown as ITerminalService);
services.registerInstance(IDebugService, { get sessions() { return runningSessions === 'debug' ? [{ state: 'stopped' }] : runningSessions === 'exited' ? [{ state: 'terminated' }] : []; } } as unknown as IDebugService);

const recovery: IAppServerConnectionRecovery & { status: IAppServerConnectionRecovery['status']; phase: IAppServerConnectionRecovery['phase']; } = {
	phase: 'connection',
	status: 'idle', error: 'Authorization expired', onDidChange: changed.event,
	reconnect: async options => {
		recovery.phase = options?.reason === 'permissions' ? 'permissions' : 'connection';
		retries++; recovery.status = 'recovering'; changed.fire();
		if (managementMode) {
			await Promise.resolve();
			granted = savedPermissions;
			recovery.status = 'idle'; changed.fire(); permissionChanges.fire();
		}
	},
};
services.registerInstance(IAppServerApi, { get connectionGeneration() { return connectionGeneration; }, getConnectionState: async () => 'ready', getSlashCommands: async () => [], onConnectionState: () => ({ dispose() { } }), recovery });
const permissionChanges = resources.add(new Emitter<void>());
services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, onDidChange: Event.None, read: async () => ({ directoryGrantsReadable: managementAllowed, localProcessSandboxConfigured: false, sandboxBackends: [], sandboxDiagnostics: [] }) });
services.registerInstance(IWorkspaceTrustApi, {
	onDidChangeTrust: permissionChanges.event,
	readWorkspaceDirectory: async () => effectiveKnown ? granted : undefined,
	readDirectory: async path => ({ dir: path, permissions: savedPermissions }),
	listDirectories: async () => ({ revision, entries: [{ dir: workspace.getWorkspace().folders[0]!.uri.fsPath, path: workspace.getWorkspace().folders[0]!.uri.fsPath, permissions: savedPermissions }] }),
	setDirectoryPermissions: async (path, permissions, expectedRevision) => {
		if (!managementAllowed || expectedRevision !== revision) throw new Error('Directory grant revision conflict');
		if (path !== workspace.getWorkspace().folders[0]!.uri.fsPath) throw new Error('Wrong workspace path');
		grantWrites++; savedPermissions = permissions; granted = permissions; revision++; permissionChanges.fire();
		return { revision, generation: 1, disposition: 'updated' };
	},
	forgetDirectory: async () => { throw new Error('Not used'); }, createGrant: async () => { throw new Error('Not used'); }, persistGrant: async () => { throw new Error('Not used'); },
});
services.registerInstance(IRemoteAuthorityResolverService, resources.add(services.createInstance(RemoteAuthorityResolverService)));
const trustManagement = resources.add(services.createInstance(WorkspaceTrustManagementService));
services.registerInstance(IWorkspaceTrustManagementService, trustManagement);
const trustRequests = resources.add(services.createInstance(WorkspaceTrustRequestService));
services.registerInstance(IWorkspaceTrustRequestService, trustRequests);
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
const contribution = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.appServerRecovery', 'workbench.contrib.workspacePermissionStatus', 'workbench.contrib.workspaceTrustRequestHandler']));
contribution.advance(WorkbenchPhase.AfterRestored);
let closed = 0;
window.ashBannerIntegration = {
	setRunningSessions(value) { runningSessions = value; },
	addWorkspaceFolder() {
		workspace.updateWorkspace({ id: 'multi', folders: [...workspace.getWorkspace().folders, { id: 'second', name: 'second', uri: URI.file('/second'), index: 1 }] });
		permissionChanges.fire();
	},
	setRecovery(status, phase = 'connection') { recovery.status = status; recovery.phase = phase; changed.fire(); },
	setPermissions(mode) {
		effectiveKnown = mode !== 'unknown';
		granted = mode === 'trusted' ? DEVELOPMENT_DIR_PERMISSIONS : mode === 'readonly' ? READ_DIR_PERMISSIONS : RESTRICTED_DIR_PERMISSIONS;
		savedPermissions = granted;
		permissionChanges.fire();
	},
	requestTrust() {
		managementMode = true;
		void trustRequests.requestWorkspaceTrust().then(result => trustResponses.push(result === undefined ? 'canceled' : result ? 'trusted' : 'restricted'));
	},
	setManagementAllowed(value) { managementAllowed = value; },
	conflictGrant() { revision++; },
	bumpConnection() { connectionGeneration++; changed.fire(); },
	managementState: () => ({ grantWrites, saved: [...savedPermissions], path: workspace.getWorkspace().folders[0]!.uri.fsPath, trustResponses: [...trustResponses] }),
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
			setRunningSessions(value: 'none' | 'terminal' | 'debug' | 'exited'): void;
			addWorkspaceFolder(): void;
			setRecovery(status: IAppServerConnectionRecovery['status'], phase?: IAppServerConnectionRecovery['phase']): void;
			setManagementAllowed(value: boolean): void;
			conflictGrant(): void;
			bumpConnection(): void;
			managementState(): { grantWrites: number; saved: string[]; path: string; trustResponses: string[]; };
			layoutTrustEditor(width: number, height: number): void;
			setPermissions(mode: 'trusted' | 'readonly' | 'restricted' | 'unknown'): void;
			requestTrust(): void;
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
