import './media/workspaceTrustEditor.css';
import { addDisposableListener, h, isHTMLElement, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAppServerApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { defaultButtonStyles, defaultSelectBoxStyles, defaultToggleStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, workspaceTrustPermissionNames, IWorkspaceTrustApi, IWorkspaceTrustManagementService, type WorkspaceTrustPermission, type WorkspaceTrustSnapshot } from '../../../../platform/workspace/common/workspaceTrust.js';
import { localize } from '../../../../nls.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';

/** Edits a revisioned grant for the window's current roots, never for an Agents session's host. */
export class WorkspaceTrustEditor extends EditorPane {
	static readonly ID = 'workbench.editor.workspaceTrust';
	readonly id = WorkspaceTrustEditor.ID;
	private root!: HTMLElement;
	private scroll!: ScrollableElement;
	private folders!: SelectBox;
	private folderSelection!: HTMLElement;
	private folderName!: HTMLElement;
	private folderPath!: HTMLElement;
	private presets!: SelectBox;
	private heading!: HTMLElement;
	private summary!: HTMLElement;
	private status!: HTMLElement;
	private statusFooter!: HTMLElement;
	private trustButton!: Button;
	private readOnlyButton!: Button;
	private saveButton!: Button;
	private resetButton!: Button;
	private refreshButton!: Button;
	private readonly toggles = new Map<WorkspaceTrustPermission, Switch>();
	private selected = '';
	private path = '';
	private snapshot: WorkspaceTrustSnapshot | undefined;
	private saved: readonly WorkspaceTrustPermission[] = [];
	private draft = new Set<WorkspaceTrustPermission>();
	private effective: readonly WorkspaceTrustPermission[] | undefined;
	private effectiveTrusted = false;
	private active = false;
	private busy = false;
	private stale = false;
	private editable = false;
	private generation = 0;
	private connectionGeneration = 0;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustApi private readonly trust: IWorkspaceTrustApi,
		@IWorkspaceTrustManagementService private readonly management: IWorkspaceTrustManagementService,
		@IAppServerApi private readonly api: IAppServerApi,
		@IAgentCapabilitiesService private readonly capabilities: IAgentCapabilitiesService,
		@IDialogService private readonly dialogs: IDialogService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessible: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILocalizationService private readonly localization: ILocalizationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(WorkspaceTrustEditor.ID, theme, storage);
		this._register(workspace.onDidChangeWorkspace(() => { if (this.active) void this.refresh(); }));
		this._register(trust.onDidChangeTrust(() => {
			if (!this.active || this.busy) return;
			if (this.dirty) { this.stale = true; this.status.textContent = localize('workspaceTrust.changed', 'Directory grants changed. Refresh before saving; refresh discards your draft.'); this.render(); }
			else void this.refresh();
		}));
		this._register(toDisposable(() => { this.active = false; this.generation++; }));
		const connection = api.onConnectionState(() => { if (this.active) void this.refresh(); });
		this._register(toDisposable(() => connection.dispose()));
		if (api.recovery) this._register(api.recovery.onDidChange(() => { if (this.active) void this.refresh(); }));
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		const document = parent.ownerDocument;
		this.root = h(document, 'section'); this.root.className = 'ash-workspace-trust-editor'; this.root.tabIndex = -1;
		this.root.setAttribute('aria-label', localize('workspaceTrust.editorTitle', 'Workspace Trust'));
		parent.append(this.root);
		this.scroll = this._register(new ScrollableElement(this.root, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		const content = this.scroll.contentElement;
		content.classList.add('workspace-trust-content');
		const location = h(document, 'div');
		location.className = 'workspace-trust-location';
		content.append(location);
		this.folderName = h(document, 'p');
		this.folderName.className = 'workspace-trust-folder-name';
		this.folderPath = h(document, 'p');
		this.folderPath.className = 'workspace-trust-folder-path';
		location.append(this.folderName);
		const folderLabel = localize('workspaceTrust.folder', 'Workspace folder');
		this.folderSelection = h(document, 'div');
		location.append(this.folderSelection);
		this.folders = this._register(new SelectBox(this.folderSelection, { options: [], ariaLabel: folderLabel, contextViewProvider: this.contextView }, defaultSelectBoxStyles));
		this._register(this.folders.onDidSelect(({ value }) => {
			this.selected = value;
			void this.refresh();
		}));

		const overview = h(document, 'div');
		overview.className = 'workspace-trust-overview';
		content.append(overview);
		this.heading = h(document, 'h2');
		this.summary = h(document, 'p');
		overview.append(this.heading, this.summary);
		const actions = h(document, 'div');
		actions.className = 'workspace-trust-actions';
		content.append(actions);
		this.trustButton = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('workspaceTrust.enableDevelopment', 'Trust workspace'),
			presentation: 'primary',
		}));
		this.readOnlyButton = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('workspaceTrust.openReadOnly', 'Open read-only'),
			presentation: 'secondary',
		}));
		this._register(this.trustButton.onDidClick(() => { void this.savePermissions(DEVELOPMENT_DIR_PERMISSIONS); }));
		this._register(this.readOnlyButton.onDidClick(() => { void this.savePermissions(READ_DIR_PERMISSIONS); }));

		const advanced = h(document, 'details');
		advanced.className = 'workspace-trust-advanced';
		const advancedTitle = h(document, 'summary');
		advancedTitle.textContent = localize('workspaceTrust.advanced', 'Advanced permissions');
		advanced.append(advancedTitle);
		content.append(advanced);
		this._register(addDisposableListener(advanced, 'toggle', () => this.scroll.layout()));
		const advancedContent = h(document, 'div');
		advancedContent.className = 'workspace-trust-advanced-content';
		advanced.append(advancedContent);
		const description = h(document, 'p');
		description.textContent = localize('workspaceTrust.advancedDescription', 'Customize individual permissions for this folder. Changes stay in a draft until you save and confirm.');
		advancedContent.append(this.folderPath, description);
		const presetLabel = h(document, 'p');
		presetLabel.textContent = localize('workspaceTrust.preset', 'Permission preset');
		advancedContent.append(presetLabel);
		this.presets = this._register(new SelectBox(advancedContent, {
			options: [
				{ value: 'readOnly', label: localize('workspaceTrust.presetReadOnly', 'Read only') },
				{ value: 'development', label: localize('workspaceTrust.development', 'Development') },
				{ value: 'custom', label: localize('workspaceTrust.custom', 'Custom permissions') },
			], ariaLabel: presetLabel.textContent, contextViewProvider: this.contextView
		}, defaultSelectBoxStyles));
		this._register(this.presets.onDidSelect(({ value }) => {
			if (value === 'custom') return;
			this.draft = new Set(value === 'readOnly' ? READ_DIR_PERMISSIONS : DEVELOPMENT_DIR_PERMISSIONS);
			this.render();
		}));
		const permissions = h(document, 'div');
		permissions.className = 'workspace-trust-permissions';
		advancedContent.append(permissions);
		for (const permission of Object.keys(workspaceTrustPermissionNames) as WorkspaceTrustPermission[]) {
			const label = this.permissionLabel(permission);
			const toggle = this._register(new Switch(permissions, { ...defaultToggleStyles, label, ariaLabel: label }));
			this.toggles.set(permission, toggle);
			this._register(toggle.onDidChange(value => {
				if (value) this.draft.add(permission);
				else this.draft.delete(permission);
				this.render();
			}));
		}
		const advancedActions = h(document, 'div');
		advancedActions.className = 'workspace-trust-actions';
		advancedContent.append(advancedActions);
		this.saveButton = this._register(new Button(advancedActions, { ...defaultButtonStyles, label: localize('workspaceTrust.save', 'Save permissions'), presentation: 'primary' }));
		this.resetButton = this._register(new Button(advancedActions, { ...defaultButtonStyles, label: localize('workspaceTrust.reset', 'Discard changes'), presentation: 'secondary' }));
		this._register(this.saveButton.onDidClick(() => { void this.savePermissions(); }));
		this._register(this.resetButton.onDidClick(() => { this.draft = new Set(this.saved); this.render(); }));
		const note = h(document, 'p');
		note.textContent = localize('workspaceTrust.ready', 'Changes apply to future operations. Running commands are not stopped.');
		advancedContent.append(note);

		const footer = h(document, 'div');
		this.statusFooter = footer;
		footer.className = 'workspace-trust-footer';
		content.append(footer);
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		footer.append(this.status);
		this.refreshButton = this._register(new Button(footer, { ...defaultButtonStyles, label: localize('workspaceTrust.refresh', 'Refresh'), presentation: 'quiet' }));
		this._register(this.refreshButton.onDidClick(() => { void this.refresh(); }));
		const scope = this._register(this.contextKeys.createScoped(this.root)); scope.createKey('workspaceTrustEditor', true);
		const hint = (): void => { this.root.setAttribute('aria-description', this.accessible.getOpenAriaHint(AccessibilityVerbositySettingId.WorkspaceTrust) ?? ''); };
		this._register(this.configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.WorkspaceTrust)) hint(); })); hint();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) this._register(AccessibleViewRegistry.register({
			type, priority: 110, name: `workspaceTrust-${type}`, when: ContextKeyExpr.has('workspaceTrustEditor'),
			getProvider: () => {
				const focused = document.activeElement;
				if (!this.active || !isHTMLElement(focused) || !this.root.contains(focused)) return undefined;
				return new AccessibleContentProvider(AccessibleViewProviderId.WorkspaceTrust, { type }, () => type === AccessibleViewType.Help
					? localize('workspaceTrust.help', 'Workspace Trust\nThis page shows the current folder’s effective permissions on this window’s connected host, independently of the selected Agents conversation. Use Tab to reach Trust workspace or Open read-only. Each action asks for confirmation before saving and restoring the workspace connection. For multi-folder workspaces, select the folder to manage. Expand Advanced permissions with Enter or Space to review the folder path, choose a preset or change individual permission switches. Advanced changes are a draft until Save permissions is confirmed. Discard changes restores the saved permissions. When permissions cannot be applied or read, Refresh rereads them and discards drafts. If grants, workspace or connection change, review the refreshed permissions before saving. Running commands are not stopped by revoking permissions. Hosts without management authority can only view permissions. Escape closes this help and returns focus.')
					: [this.folderName.textContent, this.folderPath.textContent, this.heading.textContent, this.summary.textContent, ...[...this.draft].map(permission => this.permissionLabel(permission)), this.status.textContent].join('\n'),
					() => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.WorkspaceTrust);
			},
		}));
		this.render();
	}

	async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.active = true; await this.refresh(); signal.throwIfAborted(); }
	clearInput(): void { this.active = false; this.generation++; }
	focus(): void { this.root.focus(); }
	layout(dimension: IDimension): void { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; this.scroll.layout(); }
	private permissionLabel(permission: WorkspaceTrustPermission): string { return this.localization.translate('ash.settings', `capabilities.permission.${permission}`, workspaceTrustPermissionNames[permission]); }
	private get dirty(): boolean { return this.saved.length !== this.draft.size || this.saved.some(permission => !this.draft.has(permission)); }
	private current(generation: number): boolean { return this.active && !this.isDisposed && this.generation === generation; }

	private render(): void {
		if (!this.root) return;
		const enabled = this.editable && !!this.snapshot && !this.busy && !this.stale;
		this.folders.enabled = !this.busy;
		this.presets.enabled = enabled;
		const matches = (permissions: readonly WorkspaceTrustPermission[]): boolean => permissions.length === this.draft.size && permissions.every(permission => this.draft.has(permission));
		this.presets.value = matches(READ_DIR_PERMISSIONS) ? 'readOnly' : matches(DEVELOPMENT_DIR_PERMISSIONS) ? 'development' : 'custom';
		for (const [permission, toggle] of this.toggles) { toggle.checked = this.draft.has(permission); toggle.enabled = enabled; }
		this.saveButton.enabled = enabled && this.dirty;
		this.trustButton.enabled = enabled;
		this.readOnlyButton.enabled = enabled;
		// Presets use the same revisioned save path as advanced changes, without creating a draft first.
		this.trustButton.hidden = !this.selected || this.samePermissions(this.saved, DEVELOPMENT_DIR_PERMISSIONS);
		this.readOnlyButton.hidden = !this.selected || this.samePermissions(this.saved, READ_DIR_PERMISSIONS);
		this.resetButton.enabled = !this.busy && this.dirty;
		this.refreshButton.enabled = !this.busy;
		this.statusFooter.hidden = this.effective !== undefined && this.editable && !this.busy && !this.stale;
		this.renderOverview();
		this.scroll.layout();
	}

	private samePermissions(left: readonly WorkspaceTrustPermission[], right: readonly WorkspaceTrustPermission[]): boolean {
		return left.length === right.length && left.every(permission => right.includes(permission));
	}

	private renderOverview(): void {
		if (this.effective === undefined) {
			this.heading.textContent = localize('workspaceTrust.stateUnknown', 'Workspace permissions');
			this.summary.textContent = localize('workspaceTrust.noEffective', 'Effective directory permissions are unavailable.');
			return;
		}
		const readOnly = this.samePermissions(this.effective, READ_DIR_PERMISSIONS);
		const development = this.effectiveTrusted && this.samePermissions(this.effective, DEVELOPMENT_DIR_PERMISSIONS);
		this.heading.textContent = development
			? localize('workspaceTrust.stateTrusted', 'Trusted workspace')
			: readOnly
				? localize('workspaceTrust.stateReadOnly', 'Read-only workspace')
				: localize('workspaceTrust.stateCustom', 'Custom permissions');
		this.summary.textContent = development
			? localize('workspaceTrust.trustedDescription', 'Files, commands and workspace integrations are enabled.')
			: readOnly
				? localize('workspaceTrust.readOnlyDescription', 'You can browse files. Editing and commands are disabled.')
				: localize('workspaceTrust.customDescription', 'Some features are limited. Review them in Advanced permissions.');
	}

	private async refresh(): Promise<void> {
		if (!this.active) return;
		const generation = ++this.generation;
		this.busy = true; this.editable = false; this.snapshot = undefined; this.effective = undefined; this.effectiveTrusted = false; this.saved = []; this.draft.clear(); this.stale = false;
		const folders = this.workspace.getWorkspace().folders;
		if (!folders.some(folder => folder.uri.toString() === this.selected)) this.selected = folders[0]?.uri.toString() ?? '';
		const selectedFolder = folders.find(folder => folder.uri.toString() === this.selected);
		this.folderName.textContent = selectedFolder?.name ?? localize('workspaceTrust.folder', 'Workspace folder');
		this.folderPath.textContent = selectedFolder
			? selectedFolder.uri.scheme === 'file' ? selectedFolder.uri.fsPath : `${selectedFolder.uri.authority}${selectedFolder.uri.path}`
			: '';
		this.folderSelection.hidden = folders.length < 2;
		this.folders.setOptions(folders.map(folder => ({ value: folder.uri.toString(), label: folder.name, description: folder.uri.path })));
		this.folders.value = this.selected;
		this.status.textContent = localize('workspaceTrust.loading', 'Reading workspace permissions…'); this.render();
		try {
			const folder = folders.find(folder => folder.uri.toString() === this.selected);
			if (!folder) { this.status.textContent = localize('workspaceTrust.noFolders', 'Open a workspace folder to manage its directory permissions.'); return; }
			const connectionGeneration = this.api.connectionGeneration;
			if (await this.api.getConnectionState() !== 'ready' || this.api.recovery && this.api.recovery.status !== 'idle') {
				if (this.current(generation)) this.status.textContent = localize('workspaceTrust.disconnected', 'Wait for the workspace connection to recover, then refresh.'); return;
			}
			const [info, capabilities] = await Promise.all([this.management.getUriTrustInfo(folder.uri), this.capabilities.read()]);
			if (!this.current(generation) || connectionGeneration !== this.api.connectionGeneration) return;
			this.effective = info.permissions;
			this.effectiveTrusted = info.trusted;
			if (info.uri.scheme !== folder.uri.scheme || (isRemoteResource(info.uri) ? info.uri.authority !== folder.uri.authority : info.uri.scheme !== 'file')) {
				this.status.textContent = localize('workspaceTrust.unsupported', 'This host cannot manage directory permissions for this workspace.'); return;
			}
			this.path = isRemoteResource(info.uri) ? getRemoteWorkspacePath(info.uri) : info.uri.fsPath;
			if (!capabilities.directoryGrantsReadable) {
				this.saved = info.permissions ?? []; this.draft = new Set(this.saved);
				this.status.textContent = localize('workspaceTrust.hostOnly', 'Directory permissions can only be changed by an authorized desktop host.'); return;
			}
			const [snapshot, resolved] = await Promise.all([this.trust.listDirectories(), this.trust.readDirectory(this.path)]);
			if (!this.current(generation) || connectionGeneration !== this.api.connectionGeneration) return;
			this.snapshot = snapshot; this.connectionGeneration = connectionGeneration;
			this.saved = snapshot.entries.find(entry => entry.dir === resolved.dir)?.permissions ?? info.permissions ?? [];
			this.draft = new Set(this.saved); this.editable = !!this.api.recovery;
			this.status.textContent = this.editable
				? localize('workspaceTrust.ready', 'Changes apply to future operations. Running commands are not stopped.')
				: localize('workspaceTrust.hostOnly', 'Directory permissions can only be changed by an authorized desktop host.');
		} catch (error) {
			if (this.current(generation)) this.status.textContent = localize('workspaceTrust.readFailed', 'Could not read workspace permissions: {0}', String(error));
		} finally { if (this.current(generation)) { this.busy = false; this.render(); } }
	}

	private async savePermissions(preset?: readonly WorkspaceTrustPermission[]): Promise<void> {
		if (!this.editable || !this.snapshot || this.busy || this.stale || (!preset && !this.dirty)) return;
		const generation = this.generation;
		const connectionGeneration = this.connectionGeneration;
		const revision = this.snapshot.revision;
		const path = this.path;
		const selected = this.selected;
		const permissions = [...(preset ?? this.draft)];
		const development = this.samePermissions(permissions, DEVELOPMENT_DIR_PERMISSIONS);
		const readOnly = this.samePermissions(permissions, READ_DIR_PERMISSIONS);
		const primaryButton = preset
			? development ? localize('workspaceTrust.enableDevelopment', 'Trust workspace') : localize('workspaceTrust.openReadOnly', 'Open read-only')
			: localize('workspaceTrust.save', 'Save permissions');
		this.busy = true; this.render();
		try {
			const result = await this.dialogs.confirm({
				message: development
					? localize('workspaceTrust.confirmTrust', 'Trust {0} and enable development?', this.folderName.textContent)
					: readOnly
						? localize('workspaceTrust.confirmReadOnly', 'Open {0} read-only?', this.folderName.textContent)
						: localize('workspaceTrust.confirm', 'Apply directory permissions to {0}?', path),
				detail: development
					? localize('workspaceTrust.confirmTrustDetail', 'This allows editing files, running commands and loading workspace integrations in {0}. Only continue if you trust this project. The workspace connection will be restored.', path)
					: readOnly
						? localize('workspaceTrust.confirmReadOnlyDetail', 'This allows browsing and searching files in {0}. Editing files, running commands and workspace integrations will be disabled. The workspace connection will be restored. Running commands are not stopped.', path)
						: localize('workspaceTrust.confirmDetail', 'Allowed capabilities: {0}\nThis saves a directory grant on the connected host and restores the workspace connection. Running commands are not stopped.', permissions.map(permission => this.permissionLabel(permission)).join(', ') || localize('workspaceTrust.none', 'None')),
				primaryButton,
			});
			// Confirmation may outlive the selected workspace or connection. It authorizes only this captured target.
			if (!result.confirmed || !this.current(generation) || connectionGeneration !== this.api.connectionGeneration) return;
			await this.trust.setDirectoryPermissions(path, permissions, revision);
			if (!this.current(generation) || connectionGeneration !== this.api.connectionGeneration) return;
			this.status.textContent = localize('workspaceTrust.applying', 'Permissions saved. Restoring the workspace connection…');
			await this.api.recovery?.reconnect();
			// Recovery invalidates the old snapshot. Reread the still-open folder before restoring focus.
			if (this.active && this.selected === selected) {
				await this.refresh();
				if (preset && this.active && this.selected === selected) this.root.focus();
			}
		} catch (error) {
			if (this.current(generation)) {
				this.stale = true;
				this.status.textContent = localize('workspaceTrust.saveFailed', 'Could not apply permissions. Refresh before trying again: {0}', String(error));
			}
		} finally { if (this.current(generation)) { this.busy = false; this.render(); } }
	}
}
