import { CHANNEL_NOTES_CONTENT_TYPE } from '../common/collab.js';
import { URI } from '../../../../base/common/uri.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ICallService } from '../../../../platform/call/common/callService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isDocumentCollaborationEditor, DocumentTypes } from '../../../services/documentEditor/common/documentTypes.js';
import './media/collab.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import type { IAction } from '../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IChannelService, type Channel, type ChannelRole, type ChannelFailure } from '../../../../platform/collab/common/channelService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';

/** One shared channel tree; only search, focus and expansion are local UI state. */
export class CollabViewPane extends ViewPane {
	private readonly busyProgress = this._register(new MutableDisposable());
	private readonly tree: WorkbenchObjectTree<Channel>;
	private readonly search: HTMLInputElement;
	private readonly message: HTMLElement;
	private readonly connectionNote: HTMLElement;
	private readonly connectButton: Button;
	private readonly toolbar: WorkbenchToolBar;
	private readonly selectionLabel: HTMLElement;
	private readonly selectionToolbar: WorkbenchToolBar;
	private readonly watching = this._register(new MutableDisposable<IDisposable>());
	private readonly quickPicks = this._register(new DisposableStore());
	private readonly rowResources = this._register(new DisposableStore());
	private readonly channelService: IChannelService | undefined;
	private get channels(): readonly Channel[] | undefined { return this.channelService?.space?.channels; }
	private get role(): ChannelRole | undefined { const space = this.channelService?.space; return space?.members.find(member => member.id === space.memberId)?.role; }
	private get writable(): boolean { return !!this.channelService && !this.channelService.busy && !this.channelService.error && (this.role === 'owner' || this.role === 'editor'); }
	private selectedId: string | undefined;
	private readonly collapsedChannels = new Set<string>();
	private connectionGeneration = 0;
	private resourceBusy = false;
	private resourceError: string | undefined;

	constructor(
		container: HTMLElement, options: IViewPaneOptions,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IHoverService private readonly hover: IHoverService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(container, { ...options, headerActionsVisibility: 'whenExpanded' });
		this.channelService = instantiation.invokeFunction(accessor => accessor.getOptional(IChannelService));
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-collaboration');
		this.search = h(document, 'input');
		this.search.type = 'search';
		this.search.className = 'collaboration-search';
		this.search.placeholder = localize('collaboration.search', 'Search channels');
		this.search.setAttribute('aria-label', this.search.placeholder);
		this.connectionNote = h(document, 'div');
		this.connectionNote.className = 'collaboration-connection';
		this.connectionNote.setAttribute('role', 'status');
		this.message = h(document, 'div');
		this.message.className = 'collaboration-empty';
		this.message.setAttribute('role', 'status');
		this.contentElement.append(this.search, this.connectionNote, this.message);
		this.connectButton = this._register(new Button(this.contentElement, { ...defaultButtonStyles, presentation: 'secondary', label: localize('collaboration.connect', 'Connect Channels') }));
		this.connectButton.domNode.classList.add('collaboration-connect-button');
		this.connectButton.label = localize('collaboration.connect', 'Connect Channels');
		this._register(this.connectButton.onDidClick(() => { void this.connect(); }));
		this.tree = this._register(new WorkbenchObjectTree<Channel>(this.contentElement, {
			configurationService: configuration,
			modelOptions: { identityProvider: { getId: channel => channel.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: channel => channel.name },
			multipleSelectionSupport: false, expandOnlyOnTwistieClick: true, indent: 16,
			getHeight: () => 32,
			onWillRender: () => this.rowResources.clear(),
			renderElement: channel => {
				const row = h(document, 'span');
				row.className = 'collaboration-channel';
				row.dataset.channelId = channel.id;
				const icon = h(document, 'span');
				icon.className = 'collaboration-channel-icon';
				icon.textContent = '#';
				icon.setAttribute('aria-hidden', 'true');
				const label = h(document, 'span');
				label.className = 'collaboration-channel-name';
				label.textContent = channel.name;
				row.append(icon, label);
				this.rowResources.add(this.hover.setupDelayedHover(row, { content: channel.name }));
				return row;
			},
		}));
		this.tree.element.classList.add('collaboration-tree');
		const selection = h(document, 'div');
		selection.className = 'collaboration-selection';
		this.selectionLabel = h(document, 'span');
		this.selectionLabel.className = 'collaboration-selection-label';
		selection.append(this.selectionLabel);
		this.selectionToolbar = this._register(new WorkbenchToolBar(selection, menus, { ariaLabel: localize('collaboration.channelActions', 'Channel Actions') }));
		this.contentElement.append(selection);
		this._register(hover.setupDelayedHover(this.selectionLabel, () => ({ content: this.selectionLabel.textContent ?? '' })));
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, menus, { ariaLabel: localize('collaboration.actions', 'Channels Actions') }));
		this._register(this.tree.onDidChangeSelection(({ elements, browserEvent }) => {
			if (!browserEvent) return;
			this.selectedId = elements[0]?.id;
			this.updateActions();
		}));
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed, browserEvent }) => {
			if (!browserEvent || this.search.value.trim()) return;
			if (collapsed) this.collapsedChannels.add(element.id); else this.collapsedChannels.delete(element.id);
		}));
		this._register(addDisposableListener(this.search, 'input', () => this.render()));
		this._register(addDisposableListener(this.search, 'keydown', event => {
			if (event.key === 'Escape' && this.search.value) { event.preventDefault(); event.stopPropagation(); this.search.value = ''; this.render(); }
			if (event.key === 'ArrowDown') { event.preventDefault(); this.focusTree(); }
		}));
		this._register(addDisposableListener(this.tree.element, 'contextmenu', event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('[data-channel-id]');
			const id = row?.dataset.channelId ?? this.tree.focus?.id;
			if (id) { event.preventDefault(); this.showChannelMenu(id); }
		}));
		this._register(addDisposableListener(this.tree.element, 'dblclick', event => {
			const id = (event.target as HTMLElement).closest<HTMLElement>('[data-channel-id]')?.dataset.channelId;
			if (id) void this.openResource(id, 'notes');
		}));
		this._register(addDisposableListener(this.tree.element, 'keydown', event => {
			const id = this.tree.focus?.id;
			if (id && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
				event.preventDefault(); event.stopPropagation(); this.showChannelMenu(id);
			} else if (id && event.key === 'Enter') {
				event.preventDefault(); event.stopPropagation(); void this.openResource(id, 'notes');
			} else if (id && event.key === 'F2') {
				event.preventDefault(); event.stopPropagation(); void this.editChannel(id);
			}
		}));
		const updateHint = () => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Collaboration);
			this.tree.element.setAttribute('aria-label', [localize('collaboration.channels', 'Channels'), hint].filter(Boolean).join('. '));
		};
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.Collaboration)) updateHint(); }));
		updateHint();
		if (this.channelService) {
			let spaceId = this.channelService.space?.id;
			let revision = this.channelService.space?.revision;
			this._register(this.channelService.onDidChange(() => {
				const space = this.channelService?.space;
				if (space?.id !== spaceId) { this.connectionGeneration++; this.selectedId = undefined; this.collapsedChannels.clear(); this.search.value = ''; this.resourceError = undefined; }
				if (revision !== undefined && space && space.id === spaceId && space.revision !== revision) status(localize('collaboration.updated', 'Channels and members updated.'));
				spaceId = space?.id; revision = space?.revision;
				this.render();
			}));
			this._register(this.onDidChangeVisibility(visible => { if (visible) this.watching.value = this.channelService!.watch(); else this.watching.clear(); }));
		}
		this.render();
	}

	public override focus(): void { if (this.channels) this.search.focus(); else this.connectButton.focus(); }

	public getAccessibleContent(): string {
		return [localize('collaboration.channels', 'Channels'), this.connectionNote.hidden ? '' : this.connectionNote.textContent,
		this.message.hidden ? '' : this.message.textContent,
		...this.tree.getVisibleElements().map(channel => this.path(channel)),
		this.selectionLabel.textContent,
		...(this.channelService?.space?.members.map(member => `${member.name}: ${this.roleLabel(member.role)}`) ?? [])].filter(Boolean).join('\n');
	}


	private path(channel: Channel): string {
		const parent = this.channels?.find(entry => entry.id === channel.parentId);
		return parent ? `${this.path(parent)} / ${channel.name}` : `# ${channel.name}`;
	}

	private render(): void {
		if (this.channelService?.busy && !this.busyProgress.value) {
			const progress = this.getProgressIndicator().show(true, 150);
			this.busyProgress.value = toDisposable(() => progress.done());
		} else if (!this.channelService?.busy) this.busyProgress.clear();
		const query = this.search.value.trim().toLocaleLowerCase();
		const build = (parentId?: string): ObjectTreeElement<Channel>[] => (this.channels ?? [])
			.filter(channel => channel.parentId === parentId).flatMap(channel => {
				const children = build(channel.id);
				if (query && !channel.name.toLocaleLowerCase().includes(query) && !children.length) return [];
				return [{ element: channel, children, collapsed: !query && this.collapsedChannels.has(channel.id) }];
			});
		const focus = this.tree.focus?.id;
		this.tree.setChildren(build());
		// ObjectTree keeps collapse state for retained identities. Search temporarily
		// expands matching paths, then restores the user's unfiltered view state.
		for (const channel of this.channels ?? []) {
			if (!this.tree.model.has(channel.id)) continue;
			if (!query && this.collapsedChannels.has(channel.id)) this.tree.collapse(channel.id);
			else this.tree.expand(channel.id);
		}
		if (focus && this.tree.model.has(focus)) this.tree.setFocus(focus);
		this.tree.setSelection(this.selectedId && this.tree.model.has(this.selectedId) ? [this.selectedId] : []);
		this.search.hidden = !this.channels;
		this.connectionNote.hidden = !this.channels && !this.channelService?.error;
		const space = this.channelService?.space;
		this.connectionNote.textContent = this.resourceError ?? (this.channelService?.error ? this.errorText(this.channelService.error)
			: space ? localize('collaboration.connection', '{0} · {1} · {2} members', space.name, this.roleLabel(this.role!), space.members.length) : '');
		this.connectButton.enabled = !!this.channelService && !this.channelService.busy;
		this.connectButton.domNode.hidden = !!this.channels;
		this.tree.element.hidden = !this.tree.getVisibleElements().length;
		this.message.hidden = !this.tree.element.hidden;
		this.message.textContent = !this.channels
			? this.channelService ? localize('collaboration.connectHelp', 'Connect to a collaboration server to create a space or join with an invitation.') : localize('collaboration.unavailable', 'Channels require a connected Ash backend.')
			: query ? localize('collaboration.noResults', 'No matching channels. Try another search.')
				: localize('collaboration.empty', 'No channels yet. Create a channel to get started.');
		this.updateActions();
	}

	private action(id: string, label: string, run: () => void | Promise<void>): IAction { return { id, label, tooltip: label, enabled: this.writable, run }; }

	private channelActions(id: string): IAction[] {
		return [
			...this.resourceActions(id),
			this.action('collaboration.newChild', localize('collaboration.newChild', 'New Subchannel'), () => this.editChannel(undefined, id)),
			this.action('collaboration.rename', localize('collaboration.rename', 'Rename Channel'), () => this.editChannel(id)),
			this.action('collaboration.remove', localize('collaboration.remove', 'Remove Channel and Subchannels'), async () => {
				const channel = this.channels?.find(entry => entry.id === id);
				if (!channel || !this.writable) return;
				const generation = this.connectionGeneration;
				const choice = await this.pick([{ label: localize('collaboration.confirmRemove', 'Remove {0} and all subchannels', channel.name) }], { title: localize('collaboration.remove', 'Remove Channel and Subchannels'), placeHolder: localize('collaboration.removeHelp', 'This removes these channels for every member of this space.') });
				if (!choice || this.isDisposed || generation !== this.connectionGeneration) return;
				await this.channelService?.edit({ type: 'remove', channelId: id });
				if (this.isDisposed || generation !== this.connectionGeneration) return;
				this.selectedId = channel.parentId; this.render(); this.focusTree();
			}),
		];
	}

	private resourceActions(id: string): IAction[] {
		const enabled = !!this.channelService?.space && !this.channelService.error && !this.channelService.busy && !this.resourceBusy;
		const calls = this.instantiation.invokeFunction(accessor => accessor.getOptional(ICallService));
		return [
			{ ...this.action('collaboration.notes', localize('collaboration.notes', 'Open channel notes'), () => this.openResource(id, 'notes')), enabled, icon: Lxicon.fileText },
			{ ...this.action('collaboration.call', localize('collaboration.call', 'Join or start channel call'), () => this.openResource(id, 'call')), enabled: enabled && !!calls && calls.canStart !== false, tooltip: calls?.canStart === false ? localize('collaboration.desktopCalls', 'Channel calls are available in the desktop app.') : localize('collaboration.call', 'Join or start channel call'), icon: Lxicon.voiceMode },
		];
	}

	private async openResource(id: string, kind: 'notes' | 'call'): Promise<void> {
		const service = this.channelService, space = service?.space;
		const channel = space?.channels.find(channel => channel.id === id);
		if (!service || !space || !channel || this.resourceBusy) return;
		const generation = this.connectionGeneration;
		const reference = { spaceId: space.id, channelId: id, serverUrl: space.serverUrl };
		this.resourceBusy = true; this.resourceError = undefined; this.updateActions();
		try {
			if (kind === 'call') {
				const calls = this.instantiation.invokeFunction(accessor => accessor.getOptional(ICallService));
				if (!calls || calls.canStart === false) return;
				if (calls.state && calls.state.connection !== 'ended' && calls.state.connection !== 'failed') {
					throw new Error(localize('collaboration.leaveCallFirst', 'Leave the current call before joining a channel call.'));
				}
				const access = await service.call(reference);
				if (this.isDisposed || generation !== this.connectionGeneration) return;
				await calls.start({ type: 'invitation', url: access.serverUrl, credential: access.credential });
				status(localize('collaboration.callJoined', 'Joined the call in {0}.', channel.name));
			} else {
				const editors = this.instantiation.invokeFunction(accessor => accessor.getOptional(IEditorService));
				if (!editors) throw new Error(localize('collaboration.notesUnavailable', 'Enable the document editor to open channel notes.'));
				const resource = URI.from({ scheme: 'untitled', path: `/channel-notes/${encodeURIComponent(space.serverUrl)}/${space.id}/${space.memberId}/${id}` });
				const contentType = CHANNEL_NOTES_CONTENT_TYPE;
				if (!DocumentTypes.find({ resource, contentType })) throw new Error(localize('collaboration.notesUnavailable', 'Enable the document editor to open channel notes.'));
				const title = localize('collaboration.notesTitle', '{0} — Notes', channel.name);
				await editors.openEditor({ resource, contentType, label: title, showBreadcrumbs: false }, { pinned: true, revealIfOpened: true });
				if (this.isDisposed || generation !== this.connectionGeneration) return;
				const pane = editors.visibleEditorPanes.find(pane => pane.workingCopy?.resource.toString() === resource.toString());
				if (!isDocumentCollaborationEditor(pane)) throw new Error(localize('collaboration.notesUnavailable', 'Enable the document editor to open channel notes.'));
				await pane.joinCollaborationDocument({ serverUrl: space.serverUrl, roomId: `channel-notes-${id}`, schemaId: 'stanza-document-v1', contentType, title }, reference);
			}
		} catch (error) {
			if (!this.isDisposed && generation === this.connectionGeneration && !isCancellationError(error)) {
				this.resourceError = error instanceof Error ? error.message : localize('collaboration.resourceFailed', 'Could not open the channel resource. Check the collaboration server and its call hosting configuration.');
			}
		} finally {
			this.resourceBusy = false;
			if (!this.isDisposed) this.render();
		}
	}

	private updateActions(): void {
		const service = this.channelService;
		const enabled = !!service && !service.busy;
		const secondary: IAction[] = service ? [
			{ ...this.action('collaboration.refresh', localize('collaboration.refresh', 'Refresh Channels'), () => service.refresh()), enabled },
			{ ...this.action('collaboration.connect', localize('collaboration.connect', 'Connect Channels'), () => this.connect()), enabled },
			{ ...this.action('collaboration.copyKey', localize('collaboration.copyKey', 'Copy My Sign-in Key'), () => this.copyKey()), enabled: enabled && !!service.space },
			{ ...this.action('collaboration.disconnect', localize('collaboration.disconnect', 'Disconnect This Account'), () => this.disconnect()), enabled },
		] : [];
		if (this.channels) secondary.unshift({
			...this.action('collaboration.collapse', localize('collaboration.collapse', 'Collapse All Channels'), () => {
				this.search.value = ''; for (const channel of this.channels ?? []) this.collapsedChannels.add(channel.id); this.render();
			}), enabled: true
		});
		this.toolbar.setActions(this.channels ? [
			{ ...this.action('collaboration.new', localize('collaboration.new', 'New Channel'), () => this.editChannel()), icon: Lxicon.add },
			{ ...this.action('collaboration.members', localize('collaboration.members', 'Members and Permissions'), () => this.members()), enabled, icon: Lxicon.collab },
		] : [], secondary);
		const channel = this.channels?.find(channel => channel.id === this.selectedId);
		this.selectionLabel.parentElement!.hidden = !channel;
		this.selectionLabel.textContent = channel ? this.path(channel) : '';
		this.selectionToolbar.setActions(channel ? this.resourceActions(channel.id) : [], channel ? this.channelActions(channel.id).slice(2) : []);
	}

	private focusTree(): void {
		const first = this.tree.getVisibleElements()[0];
		if (!first) { this.search.focus(); return; }
		const id = this.selectedId && this.tree.model.has(this.selectedId) ? this.selectedId : first.id;
		this.tree.expandTo(id); this.tree.setFocus(id); this.tree.reveal(id); this.tree.domFocus();
	}

	private showChannelMenu(id: string): void {
		this.selectedId = id; this.tree.setSelection([id]); this.tree.setFocus(id); this.updateActions();
		const anchor = this.tree.element.querySelector<HTMLElement>(`[data-channel-id="${id}"]`) ?? this.tree.element;
		this.menus.showContextMenu({
			getAnchor: () => anchor, getActions: () => this.channelActions(id), autoSelectFirstItem: true,
			onHide: cancelled => { if (cancelled && !this.isDisposed) this.tree.domFocus(); }
		});
	}

	private async editChannel(id?: string, parentId?: string): Promise<void> {
		if (!this.writable) return;
		const generation = this.connectionGeneration;
		const existing = this.channels?.find(channel => channel.id === id);
		parentId = existing?.parentId ?? parentId;
		const name = await this.quickInput.input({
			title: existing ? localize('collaboration.rename', 'Rename Channel') : parentId ? localize('collaboration.newChild', 'New Subchannel') : localize('collaboration.new', 'New Channel'),
			placeHolder: localize('collaboration.namePrompt', 'Channel name'), value: existing?.name ?? '',
			validateInput: async value => {
				const name = value.trim();
				if (!name || name.length > 80 || /[\r\n\x00-\x1f/]/.test(name)) return localize('collaboration.invalidName', 'Use 1–80 characters without slashes or control characters.');
				if (this.channels?.some(channel => channel.id !== id && channel.parentId === parentId && channel.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return localize('collaboration.duplicateName', 'A channel with this name already exists here.');
				return undefined;
			},
		});
		if (this.isDisposed || generation !== this.connectionGeneration || !this.channels) return;
		if (name !== undefined) {
			const before = new Set(this.channels.map(channel => channel.id));
			await this.channelService?.edit(existing ? { type: 'rename', channelId: existing.id, name: name.trim() } : { type: 'create', parentId, name: name.trim() });
			if (this.isDisposed || generation !== this.connectionGeneration) return;
			this.selectedId = existing?.id ?? this.channels?.find(channel => !before.has(channel.id))?.id;
			let parent = parentId;
			while (parent) { this.collapsedChannels.delete(parent); parent = this.channels?.find(entry => entry.id === parent)?.parentId; }
			this.search.value = ''; this.render();
		}

		this.focusTree();
	}
	private pick<T extends IQuickPickItem>(items: readonly T[], options: { title: string; placeHolder?: string; }): Promise<T | undefined> {
		return new Promise(resolve => {
			const resources = this.quickPicks.add(new DisposableStore());
			const picker = resources.add(this.quickInput.createQuickPick<T>());
			picker.ariaLabel = options.title; picker.placeholder = options.placeHolder ?? options.title; picker.items = items;
			resources.add(toDisposable(() => resolve(undefined)));
			resources.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0] ?? picker.activeItems[0]); picker.hide(); }));
			resources.add(picker.onDidHide(() => { this.quickPicks.delete(resources); }));
			picker.show();
		});
	}

	private async copyKey(): Promise<void> {
		const key = await this.channelService?.signInKey();
		if (key && !this.isDisposed) {
			await this.instantiation.invokeFunction(accessor => accessor.get(IClipboardService).writeText(JSON.stringify(key)));
			status(localize('collaboration.keyCopied', 'Sign-in key copied. Keep it privately to reconnect as this member. Use Invite Member for another person.'));
		}
	}
	private async confirmAccountChange(): Promise<boolean> {
		if (!this.channelService?.space) return true;
		const action = await this.pick([
			{ label: localize('collaboration.copyKey', 'Copy My Sign-in Key'), id: 'copy' },
			{ label: localize('collaboration.forgetAccount', 'Continue and Forget Saved Account'), id: 'continue' },
		], { title: localize('collaboration.accountChange', 'Change Collab Account'), placeHolder: localize('collaboration.keepKey', 'Keep your sign-in key before leaving. Without it, you will need another administrator to invite you.') });
		if (action?.id === 'copy') await this.copyKey();
		return action?.id === 'continue' && !this.isDisposed;
	}
	private async disconnect(): Promise<void> {
		if (await this.confirmAccountChange()) await this.channelService?.disconnect();
	}

	private async connect(): Promise<void> {
		const service = this.channelService;
		if (!service || service.busy || !(await this.confirmAccountChange())) return;
		const mode = await this.pick([
			{ label: localize('collaboration.join', 'Join with Invitation'), type: 'join' as const },
			{ label: localize('collaboration.createSpace', 'Create Collab Space'), type: 'create' as const },
		], { title: localize('collaboration.connect', 'Connect Channels') });
		if (!mode || this.isDisposed) return;
		if (mode.type === 'join') {
			const invitation = await this.quickInput.input({
				title: localize('collaboration.join', 'Join with Invitation'), password: true,
				placeHolder: localize('collaboration.invitationPrompt', 'Paste the invitation copied by a space administrator'),
				validateInput: async value => this.parseInvitation(value) ? undefined : localize('collaboration.invalidInvitation', 'Paste a complete channel invitation.')
			});
			const parsed = invitation && this.parseInvitation(invitation);
			if (parsed && !this.isDisposed) await service.connect({ type: 'join', ...parsed });
		} else {
			const serverUrl = await this.quickInput.input({
				title: localize('collaboration.server', 'Collab Server'), placeHolder: 'https://collaboration.example.com', value: service.space?.serverUrl,
				validateInput: async value => this.validServer(value) ? undefined : localize('collaboration.invalidServer', 'Use an HTTPS server origin, or HTTP on localhost.')
			});
			if (!serverUrl || this.isDisposed) return;
			const administrator = await this.quickInput.input({ title: localize('collaboration.administrator', 'Server Administrator Credential'), password: true });
			if (!administrator || this.isDisposed) return;
			const name = await this.quickInput.input({ title: localize('collaboration.spaceName', 'Space Name'), validateInput: async value => this.validateName(value) });
			if (!name || this.isDisposed) return;
			const memberName = await this.quickInput.input({ title: localize('collaboration.memberName', 'Your Display Name'), validateInput: async value => this.validateName(value) });
			if (memberName && !this.isDisposed) await service.connect({ type: 'create', serverUrl: serverUrl.trim(), administrator, name: name.trim(), memberName: memberName.trim() });
		}
		if (!this.isDisposed) this.focus();
	}

	private async members(): Promise<void> {
		const service = this.channelService;
		const space = service?.space;
		if (!service || !space || service.busy) return;
		const generation = this.connectionGeneration;
		const owner = this.role === 'owner';
		const items = space.members.map(member => ({ label: member.name, description: this.roleLabel(member.role), id: member.id }));
		if (owner) items.unshift({ label: localize('collaboration.invite', 'Invite Member'), description: '', id: 'invite' });
		const member = await this.pick(items, { title: localize('collaboration.members', 'Members and Permissions'), placeHolder: localize('collaboration.inheritance', 'Members can access every channel in this space. Subchannels inherit the same permissions.') });
		if (!member || !owner || this.isDisposed || generation !== this.connectionGeneration) return;
		if (member.id === 'invite') {
			const name = await this.quickInput.input({ title: localize('collaboration.invitee', 'Member Display Name'), validateInput: async value => this.validateName(value) });
			if (!name || this.isDisposed || generation !== this.connectionGeneration) return;
			const role = await this.pickRole();
			if (!role || this.isDisposed || generation !== this.connectionGeneration) return;
			const invitation = await service.invite(name.trim(), role);
			if (!invitation || this.isDisposed) return;
			const copy = await this.pick([{ label: localize('collaboration.copyInvitation', 'Copy Invitation') }], { title: localize('collaboration.invitationReady', 'Invitation for {0}', name.trim()), placeHolder: localize('collaboration.invitationSecret', 'This invitation grants access. Share it privately with this member.') });
			if (copy) await this.instantiation.invokeFunction(accessor => accessor.get(IClipboardService).writeText(JSON.stringify(invitation)));
		} else {
			const action = await this.pick([
				{ label: localize('collaboration.changeRole', 'Change Role'), id: 'role' },
				...(member.id === space.memberId ? [] : [{ label: localize('collaboration.removeMember', 'Remove Member'), id: 'remove' }]),
			], { title: member.label });
			if (!action || this.isDisposed || generation !== this.connectionGeneration) return;
			if (action.id === 'role') {
				const role = await this.pickRole();
				if (role && !this.isDisposed && generation === this.connectionGeneration) await service.edit({ type: 'setRole', memberId: member.id, role });
			} else {
				const confirm = await this.pick([{ label: localize('collaboration.confirmMember', 'Revoke access for {0}', member.label) }], { title: localize('collaboration.removeMember', 'Remove Member') });
				if (confirm && !this.isDisposed && generation === this.connectionGeneration) await service.edit({ type: 'removeMember', memberId: member.id });
			}
		}
	}
	private async pickRole(): Promise<ChannelRole | undefined> {
		return (await this.pick((['viewer', 'editor', 'owner'] as const).map(role => ({ label: this.roleLabel(role), role })), { title: localize('collaboration.role', 'Member Role'), placeHolder: localize('collaboration.roleHelp', 'Viewers read channels; editors change channels; administrators also manage members.') }))?.role;
	}
	private roleLabel(role: ChannelRole): string {
		return role === 'owner' ? localize('collaboration.owner', 'Administrator') : role === 'editor' ? localize('collaboration.editor', 'Editor') : localize('collaboration.viewer', 'Viewer');
	}
	private validateName(value: string): string | undefined {
		return !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f/]/.test(value) ? localize('collaboration.invalidName', 'Use 1–80 characters without slashes or control characters.') : undefined;
	}
	private validServer(value: string): boolean {
		try { const url = new URL(value.trim()); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; } catch { return false; }
	}
	private parseInvitation(value: string): { serverUrl: string; credential: string; } | undefined {
		try { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || !('serverUrl' in parsed) || !('credential' in parsed) || typeof parsed.serverUrl !== 'string' || typeof parsed.credential !== 'string' || !this.validServer(parsed.serverUrl) || !/^[0-9a-f]{64}$/i.test(parsed.credential)) return undefined; return { serverUrl: parsed.serverUrl, credential: parsed.credential }; } catch { return undefined; }
	}
	private errorText(error: ChannelFailure): string {
		switch (error) {
			case 'denied': return localize('collaboration.denied', 'Access denied. Your invitation may have been revoked.');
			case 'conflict': return localize('collaboration.conflict', 'Channels or permissions changed. Refresh before trying again.');
			case 'invalid': return localize('collaboration.invalid', 'The change is not allowed. Check names, hierarchy, and that at least one administrator remains.');
			case 'storage': return localize('collaboration.storageError', 'Could not load or save collaboration data. Check the server and secret storage, then retry.');
			case 'transport': return localize('collaboration.transportError', 'Could not reach the collaboration server. Refresh to check whether your change was saved.');
		}
	}

}
