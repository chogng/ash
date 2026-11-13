import './media/chatWindow.css';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { addDisposableListener, Dimension, h, isHTMLElement } from '../../../../base/browser/dom.js';
import { AriaLiveRegion } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { ITitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { TerminalEditorInput } from '../../terminal/browser/terminalEditorInput.js';
import { IAuxiliaryWindowService, type AuxiliaryWindowOpenOptions, type IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';
import type { IChatWindow, IChatWindowContent, IChatWindowOpenOptions, IChatWindowProvider, IChatWindowService } from './chatWindow.js';
import { ChatWindowGrid } from './chatWindowGrid.js';
import { bindChatWindowContext, CanToggleChatWindowConversationContext } from './chatWindowContextKeys.js';
import { getChatWindowActions, getTerminalPositionAction, terminalPositions } from './chatWindowLayoutActions.js';
import { getChatWindowEditorTransfers, moveChatWindowEditors } from './chatWindowEditors.js';
import { InFlightOperations } from './chatWindowOpening.js';
import { ChatWindowEditorInput } from './chatWindowParts.js';
import { ChatWindowPartFactory } from './chatWindowPartFactory.js';
import { ChatWindowsRestoration } from './chatWindowsRestoration.js';
import { type ChatWindowEdge, type ChatWindowLayoutMode, ChatWindowTerminalPosition } from '../common/chatWindowLayout.js';
import type { IStoredChatWindow } from '../common/chatWindowState.js';

function defaultChatWindowTitle(): string {
	return localize({ bundle: 'ash.workbench', key: 'chatWindow.title' }, 'Chat Window');
}

export class ChatWindowService extends Disposable implements IChatWindowService {
	declare readonly _serviceBrand: undefined;
	private readonly windows = this._register(new DisposableMap<number, ChatWindow>());
	private readonly opening = new InFlightOperations<IChatWindow | undefined, HTMLElement>();
	private readonly chatPicker = this._register(new DisposableStore());
	private provider: IChatWindowProvider | undefined;
	private readonly restoration;

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@IDialogService private readonly dialogs: IDialogService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		this.restoration = instantiationService.createInstance(ChatWindowsRestoration);
		this._register(storage.onWillSaveState(({ reason }) => {
			// Terminal shutdown can flush again after disposing live terminal tabs.
			if (reason !== WillSaveStateReason.SHUTDOWN && lifecycle.willShutdown) return;
			const states = [...this.windows].flatMap(([, window]) => {
				const state = window.createState();
				return state ? [state] : [];
			});
			this.restoration.save(states);
		}));
	}

	public registerProvider(provider: IChatWindowProvider): IDisposable {
		this.assertNotDisposed();
		this.provider = provider;
		return toDisposable(() => {
			if (this.provider === provider) this.provider = undefined;
		});
	}

	public async open(chat: URI, options?: IChatWindowOpenOptions): Promise<IChatWindow | undefined> {
		this.assertNotDisposed();
		const provider = this.provider;
		const content = provider?.resolveContent(chat);
		if (!provider || !content?.isAvailable()) return undefined;

		return this.opening.run(content.element, async () => {
			const existing = [...this.windows].find(([, window]) => window.has(content.element))?.[1];
			if (existing) {
				await existing.reveal(content.element, options?.preserveFocus);
				return existing.isDisposed ? undefined : existing;
			}
			const target = options?.window && this.windows.get(options.window.windowId);
			if (target === options?.window && target) {
				await target.addChat(chat, content, options?.preserveFocus);
				return target.isDisposed ? undefined : target;
			}
			return this.openWindow(content.title, options?.bounds,
				window => window.addChat(chat, content, options?.preserveFocus),
				() => this.provider === provider && content.isAvailable());
		});
	}

	public getWindow(windowId: number): IChatWindow | undefined {
		return this.windows.get(windowId);
	}

	public get activeWindow(): IChatWindow | undefined {
		return [...this.windows].find(([, window]) => window.hasFocus)?.[1];
	}

	get hasWindowsToRestore(): boolean { return this.restoration.hasPendingWindows; }

	async openNewChat(window: IChatWindow): Promise<void> {
		if (this.getWindow(window.windowId) !== window) return;
		const resource = this.provider?.createChat?.(window.chat.get());
		if (resource) await this.open(resource, { window });
	}

	pickChat(window: IChatWindow): void {
		const provider = this.provider;
		if (!provider?.getChats || this.getWindow(window.windowId) !== window) return;
		this.chatPicker.clear();
		const quickInput = this.instantiationService.invokeFunction(accessor => accessor.get(IQuickInputService));
		const picker = this.chatPicker.add(quickInput.createQuickPick<IQuickPickItem & { resource: URI; }>());
		picker.placeholder = getChatWindowActions().pickChat.title.value;
		const opened = new Set(window.chats.get().map(chat => chat.toString()));
		picker.items = provider.getChats().filter(({ resource }) => !opened.has(resource.toString()))
			.map(({ resource, title, description }) => ({ resource, label: title, description }));
		this.chatPicker.add(picker.onDidAccept(() => {
			const item = picker.activeItems[0];
			if (!item) return;
			picker.hide();
			void this.openPickedChat(provider, window, item.resource).catch(error => this.notifications.error(String(error)));
		}));
		this.chatPicker.add(picker.onDidHide(() => this.chatPicker.clear()));
		picker.show();
	}

	private async openPickedChat(provider: IChatWindowProvider, window: IChatWindow, resource: URI): Promise<void> {
		await provider.prepareChat?.(resource);
		if (this.provider === provider && this.getWindow(window.windowId) === window) await this.open(resource, { window });
	}

	async restoreWindows(): Promise<void> {
		const provider = this.provider;
		if (!provider?.prepareChat) return;
		await this.restoration.restore(
			chat => provider.prepareChat!(chat),
			(chat, options) => this.provider === provider ? this.open(chat, options) : Promise.resolve(undefined),
			async (window, state) => { await this.windows.get(window.windowId)?.restoreLayout(state); },
			async (state, bounds) => {
				await this.openWindow(defaultChatWindowTitle(), bounds, window => window.restoreLayout(state));
			},
			error => this.notifications.error(String(error)),
		);
	}

	public async moveToMainWindow(window: IChatWindow): Promise<void> {
		const managed = this.windows.get(window.windowId);
		if (managed !== window) return;
		const veto = managed.getMoveVeto();
		if (veto) {
			await this.dialogs.error(veto);
			return;
		}
		if (await managed.prepareReturn() && !managed.isDisposed) this.auxiliaryWindows.getWindow(window.windowId)?.window.close();
	}

	private async openWindow(
		title: string,
		bounds: AuxiliaryWindowOpenOptions | undefined,
		initialize: (window: ChatWindow) => Promise<void>,
		canOpen = () => true,
	): Promise<IChatWindow | undefined> {
		const window = await this.auxiliaryWindows.open({ width: 900, height: 760, ...bounds, title });
		try {
			if (this.isDisposed || window.isDisposed || !canOpen()) {
				window.dispose();
				return undefined;
			}
			const chatWindow = this.instantiationService.createInstance(ChatWindow, window, title,
				() => this.windows.deleteAndDispose(window.id), (window: IChatWindow) => this.moveToMainWindow(window));
			this.windows.set(window.id, chatWindow);
			window.layout();
			await initialize(chatWindow);
			if (chatWindow.isDisposed) return undefined;
			return chatWindow.finishOpening() ? chatWindow : undefined;
		} catch (error) {
			this.windows.deleteAndDispose(window.id);
			window.dispose();
			throw error;
		}
	}

	protected override disposeCore(): void {
		this.provider = undefined;
		super.disposeCore();
	}
}

class ChatWindow extends Disposable implements IChatWindow {
	readonly chatPart;
	readonly mainPart;
	readonly terminalsPart;
	readonly chat = observableValue<URI | undefined>(this, undefined);
	readonly chats = observableValue<readonly URI[]>(this, []);
	private readonly tabs = new DisposableMap<HTMLElement, DisposableStore>();
	private readonly titlebar;
	private readonly grid;
	private readonly partFactory;
	private readonly announcements;
	private tabQueue = Promise.resolve();
	private closing = false;
	private returned = false;
	private opening = true;

	constructor(
		private readonly window: IAuxiliaryWindow,
		title: string,
		private readonly disposeWindow: () => void,
		moveToMainWindow: (window: IChatWindow) => Promise<void>,
		@IEditorPartsService private readonly editors: IEditorPartsService,
		@ITitleService titleService: ITitleService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ILifecycleService lifecycle: ILifecycleService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this._register(toDisposable(() => window.dispose()));
		try {
			const context = this._register(contextKeys.createScoped(window.container));
			bindChatWindowContext(context);
			this.announcements = this._register(new AriaLiveRegion(window.window.document, window.container));
			this.titlebar = titleService.createAuxiliaryTitlebarPart(window.container, unregister =>
				instantiationService.createInstance(ChatWindowTitlebar, window, title, unregister, () => moveToMainWindow(this)));
			this._register(toDisposable(() => this.titlebar.dispose()));
			const isolatedOptions = { contextKeyService: context, headerRowHeight: undefined, modalContainer: window.container };
			const acceptsDocument = (input: IResourceEditorInput) => !(input instanceof ChatWindowEditorInput || input instanceof TerminalEditorInput);
			this.chatPart = this._register(editors.createEditorPart(window.container, {
				...isolatedOptions,
				canDropEditor: input => input instanceof ChatWindowEditorInput,
				supportsGroupSplitting: false,
			}));
			this.mainPart = this._register(editors.createEditorPart(window.container, {
				...isolatedOptions,
				supportsGroupSplitting: true,
				canDropEditor: acceptsDocument,
			}));
			this.terminalsPart = this._register(editors.createEditorPart(window.container, {
				...isolatedOptions,
				supportsGroupSplitting: false,
				canDropEditor: input => input instanceof TerminalEditorInput,
			}));
			this._register(editors.registerWindowEditorPart(this.chatPart, () => this.mainPart));
			this._register(editors.registerWindowEditorPart(this.mainPart, () => this.mainPart));
			this._register(editors.registerWindowEditorPart(this.terminalsPart, () => this.mainPart));
			this.grid = this._register(new ChatWindowGrid(window.container, this.chatPart, this.mainPart, this.terminalsPart));
			this.partFactory = this._register(new ChatWindowPartFactory(
				this.grid, editors, context, this.mainPart, acceptsDocument,
				() => !this.closing,
				() => this.closeWhenEmpty(), error => notifications.error(String(error)),
			));
			const canToggle = CanToggleChatWindowConversationContext.bindTo(context);
			this._register(this.grid.onDidChangeLayout(() => {
				canToggle.set(this.grid.canToggleConversation);
				this.titlebar.updateLayoutControls(this.grid.canToggleConversation, this.grid.inputOnly, this.grid.terminalPosition);
			}));
			this.titlebar.updateLayoutControls(false, false, this.grid.terminalPosition);
			this._register(window.onBeforeUnload(event => {
				if (lifecycle.willShutdown) return;
				const veto = this.getMoveVeto();
				if (veto) event.veto(veto);
				else if (this.tabs.size || this.hasEditors()) event.join(() => this.prepareReturn());
			}));
			this._register(window.onDidClose(() => this.close()));
			this._register(window.onWillLayout(size => this.grid.layout(new Dimension(size.width, Math.max(0, size.height - this.titlebar.header.offsetHeight)))));
			this._register(this.chatPart.onDidChangeEditors(event => {
				if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
					const input = event.event.editor.input;
					if (input instanceof ChatWindowEditorInput) {
						this.tabs.deleteAndDispose(input.element);
						this.closeWhenEmpty();
					}
				}
				this.updateTabs();
				this.grid.observeComposer();
			}));
			this._register(this.mainPart.onDidChangeEditors(() => {
				if (this.mainPart.groups.some(group => group.inputs.length)) this.grid.showMain();
				else this.grid.hideMain();
				this.closeWhenEmpty();
			}));
			this._register(this.terminalsPart.onDidChangeEditors(() => {
				this.grid.setTerminalsVisible(this.terminalsPart.groups.some(group => group.inputs.length));
				this.closeWhenEmpty();
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	get windowId(): number { return this.window.id; }
	get hasFocus(): boolean { return this.window.window.document.hasFocus(); }
	has(element: HTMLElement): boolean { return this.tabs.has(element); }
	showEditor(): void { this.grid.showMain(); this.mainPart.focus(); }
	get layoutMode(): ChatWindowLayoutMode { return this.grid.mode; }
	setLayoutMode(mode: ChatWindowLayoutMode): void { this.grid.setLayoutMode(mode); }
	get terminalPosition(): ChatWindowTerminalPosition { return this.grid.terminalPosition; }
	setTerminalPosition(position: ChatWindowTerminalPosition): void {
		this.grid.setTerminalPosition(position);
		this.announcements.status(getTerminalPositionAction(position).title.value);
	}
	toggleConversation(): void {
		this.grid.toggleConversation();
	}

	async moveEditorToEdge(edge: ChatWindowEdge): Promise<void> {
		const group = this.editors.activeGroup;
		const input = group.activeInput;
		if (input && this.partFactory.canMoveFrom(group)) {
			const inputs = group.selectedInputs.includes(input) ? group.selectedInputs : [input];
			await this.partFactory.moveEditorsIntoNewPart(edge, group, inputs);
		}
	}

	private get transferableParts(): readonly IEditorPart[] {
		return [this.mainPart, this.terminalsPart, ...this.partFactory.parts];
	}

	finishOpening(): boolean {
		this.opening = false;
		if (this.tabs.size || this.hasEditors()) return true;
		this.close();
		return false;
	}

	createState(): IStoredChatWindow | undefined {
		const chats = this.chats.get();
		if (this.opening || (!chats.length && !this.hasEditors())) return undefined;
		return {
			chats: chats.map(chat => chat.toString()),
			active: this.chat.get()?.toString(),
			bounds: this.window.createState(),
			layout: this.grid.mode,
			terminalPosition: this.grid.terminalPosition,
			inputOnly: this.grid.inputOnly,
			sizes: this.grid.sizes,
			editors: this.mainPart.saveWorkingSet('chatWindow.editors'),
			terminals: this.terminalsPart.saveWorkingSet('chatWindow.terminals'),
			createdParts: this.partFactory.save(),
		};
	}

	async restoreLayout(state: IStoredChatWindow): Promise<void> {
		this.setLayoutMode(state.layout);
		this.grid.setTerminalPosition(state.terminalPosition);
		await this.mainPart.applyWorkingSet(state.editors, { preserveFocus: true });
		if (this.isDisposed) return;
		await this.terminalsPart.applyWorkingSet(state.terminals, { preserveFocus: true });
		if (this.isDisposed) return;
		// Terminal visibility belongs to the window's outer split, not its single editor group.
		this.terminalsPart.setGroupVisible(this.terminalsPart.activeGroup.id, true);
		for (const saved of state.createdParts) {
			const part = this.partFactory.createPart(saved.edge, saved.size);
			try { await part.applyWorkingSet(saved.editors, { preserveFocus: true }); }
			finally { this.partFactory.removeIfEmpty(part); }
			if (this.isDisposed) return;
		}
		if (state.sizes) this.grid.restoreSizes(state.sizes);
		this.grid.setInputOnly(state.inputOnly);
	}

	private getTransfers() {
		return getChatWindowEditorTransfers(this.transferableParts, input => this.editors.getWindowEditorReturnGroup(input));
	}

	getMoveVeto(): string | undefined {
		for (const part of this.transferableParts) {
			for (const group of part.groups) {
				for (const input of group.inputs) {
					if (!input.canMove) continue;
					const veto = input.canMove(group.id, this.editors.getWindowEditorReturnGroup(input).id);
					if (typeof veto === 'string') return veto;
				}
			}
		}
		return undefined;
	}

	async prepareReturn(): Promise<boolean> {
		if (this.closing || this.isDisposed) return false;
		if (this.returned) return true;
		if (!this.hasEditors()) {
			this.selectReturnChat();
			this.returned = true;
			return true;
		}
		this.closing = true;
		try {
			this.selectReturnChat();
			await this.editors.whenReadyForWindowEditorReturn();
			if (this.isDisposed) return false;
			const transfers = this.getTransfers();
			await moveChatWindowEditors(transfers);
			const groups = [...new Set(transfers.map(entry => entry.target))];
			for (const group of groups) this.editors.setGroupVisible(group.id, true);
			if (groups[0]) this.editors.revealReturnedEditors(groups[0]);
			this.returned = true;
			return true;
		} finally {
			this.closing = false;
			for (const part of this.partFactory.parts) this.partFactory.removeIfEmpty(part);
			this.closeWhenEmpty();
		}
	}

	private selectReturnChat(): void {
		const active = this.chatPart.activeInput;
		if (active instanceof ChatWindowEditorInput) active.didReturn?.();
	}

	private hasEditors(): boolean {
		return this.transferableParts.some(part => part.groups.some(group => group.inputs.length));
	}

	private closeWhenEmpty(): void {
		if (this.opening || this.closing || this.tabs.size) return;
		queueMicrotask(() => {
			if (!this.isDisposed && !this.closing && !this.tabs.size && !this.hasEditors()) this.close();
		});
	}

	private updateTabs(): void {
		const group = this.chatPart.activeGroup;
		this.chats.set(group.inputs.map(input => input.resource), undefined);
		const active = group.activeInput;
		if (active instanceof ChatWindowEditorInput) {
			this.chat.set(active.resource, undefined);
			this.titlebar.setTitle(active.getName());
		} else {
			this.chat.set(undefined, undefined);
			this.titlebar.setTitle(defaultChatWindowTitle());
		}
	}

	addChat(chat: URI, content: IChatWindowContent, preserveFocus = false): Promise<void> {
		const open = this.tabQueue.then(() => this.openChat(chat, content, preserveFocus));
		this.tabQueue = open.catch(() => { });
		return open;
	}

	private async openChat(chat: URI, content: IChatWindowContent, preserveFocus: boolean): Promise<void> {
		if (this.isDisposed || !content.isAvailable()) return;
		const { element } = content;
		const resources = this.tabs.set(element, new DisposableStore());
		const input = resources.add(new ChatWindowEditorInput(chat, content.title, element, container => {
			container.append(element);
		}, visible => content.setVisible(visible), () => content.focus(this.window), content.layout, content.didReturn));
		try {
			content.mount({
				window: this.window,
				titleId: this.titlebar.title.id,
				resources,
				close: () => { void this.removeChat(input).catch(onUnexpectedError); },
				focus: () => this.reveal(element),
				setTitle: title => {
					const resource = content.getResource();
					if (input.resource.toString() !== resource.toString()) {
						input.resource = resource;
						this.updateTabs();
					}
					input.setTitle(title);
					if (this.chatPart.activeInput === input) this.titlebar.setTitle(title);
				},
			});
			element.classList.add('ash-chat-auxiliary-content');
			resources.add(toDisposable(() => element.classList.remove('ash-chat-auxiliary-content')));
			await this.chatPart.openEditor(input, { pinned: true, preserveFocus });
			if (!preserveFocus) await this.focus();
		} catch (error) {
			await this.chatPart.activeGroup.closeEditor(input, { skipConfirmation: true, reason: 'move' });
			this.tabs.deleteAndDispose(element);
			throw error;
		}
	}

	private async removeChat(input: ChatWindowEditorInput): Promise<void> {
		await this.chatPart.activeGroup.closeEditor(input, { skipConfirmation: true });
		this.closeWhenEmpty();
	}

	async reveal(element: HTMLElement, preserveFocus = false): Promise<void> {
		const input = this.chatPart.activeGroup.inputs.find(input => input instanceof ChatWindowEditorInput && input.element === element);
		if (input) this.chatPart.activateEditor(input);
		if (!preserveFocus) await this.focus();
	}

	async focus(): Promise<void> {
		try { await this.window.focus(); }
		catch (error) { if (!this.isDisposed) throw error; }
		if (!this.isDisposed) (this.tabs.size ? this.chatPart : this.mainPart).focus();
	}

	close(): boolean {
		if (this.isDisposed) return false;
		this.disposeWindow();
		return true;
	}

	protected override disposeCore(): void {
		// Reattach host-owned views while their popup document and group panes still exist.
		try { this.tabs.dispose(); }
		finally { super.disposeCore(); }
	}
}

/** Owns the shared chrome of a window showing a retained chat. */
class ChatWindowTitlebar extends Disposable implements ITitlebarPart {
	readonly header: HTMLElement;
	readonly title: HTMLElement;
	readonly onMenubarVisibilityChange = Event.None;
	private readonly conversation: Button;
	private terminalPosition = ChatWindowTerminalPosition.FullWidth;

	constructor(
		readonly window: IAuxiliaryWindow,
		title: string,
		onDispose: () => void,
		returnToMainWindow: () => Promise<void>,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@ICommandService commands: ICommandService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super();
		window.container.classList.add('ash-chat-auxiliary-window');
		this._register(toDisposable(() => window.container.classList.remove('ash-chat-auxiliary-window')));
		this.header = h(window.window.document, 'header', { className: 'ash-chat-auxiliary-titlebar' });
		this.title = h(window.window.document, 'span', { className: 'ash-chat-auxiliary-title' });
		this.title.id = `chat-window-title-${window.id}`;
		this.setTitle(title);
		const toolbar = h(window.window.document, 'div', { className: 'ash-chat-auxiliary-actions' });
		this.header.append(this.title, toolbar);
		window.container.append(this.header);
		this._register(toDisposable(() => this.header.remove()));
		this._register(toDisposable(onDispose));
		this._register(addDisposableListener<KeyboardEvent>(window.window, 'keydown', event => {
			if (!isHTMLElement(event.target) || !window.container.contains(event.target)) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'F1' || event.key === 'F2')) {
				event.preventDefault(); event.stopPropagation();
				accessibleViews.show(event.key === 'F1' ? AccessibleViewType.Help : AccessibleViewType.View, event.target);
			}
		}, { capture: true }));
		this._register(AccessibleViewRegistry.register({
			name: `sessions-window-${window.id}`, type: AccessibleViewType.Help, priority: 95,
			getProvider: () => {
				if (!window.window.document.hasFocus()) return undefined;
				const focused = window.window.document.activeElement as HTMLElement | null;
				if (!focused || (!this.header.contains(focused) && focused.getAttribute('role') !== 'separator')) return undefined;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChat, { type: AccessibleViewType.Help },
					() => localize({ bundle: 'ash.workbench', key: 'chatWindow.help' }, 'Use Left and Right Arrow to navigate chat tabs. Drag an editor tab to a window edge, or use a Move Editor to Window Edge command. In stacked layout, drag the separator down or use its arrow keys to show only the chat input. The title bar can show the conversation again and change the terminal position. Return to main window moves the chats and editors back.'),
					() => focused.focus(), AccessibilityVerbositySettingId.Chat,
				);
			},
		}));
		for (const { id, title, icon } of Object.values(getChatWindowActions())) {
			this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'quiet', iconOnly: true, icon, label: title.value,
				onClick: () => { void commands.executeCommand(id, { windowId: window.id }).catch(error => notifications.error(String(error))); },
			}));
		}
		const run = (id: string) => commands.executeCommand(id, { windowId: window.id }).catch(error => notifications.error(String(error)));
		this.conversation = this._register(new Button(toolbar, {
			...defaultButtonStyles, presentation: 'quiet', iconOnly: true, icon: Lxicon.chevronDown,
			label: localize({ bundle: 'ash.workbench', key: 'chatWindow.showInputOnly' }, 'Show Chat Input Only'),
			onClick: () => { void run('workbench.action.chatWindow.toggleConversation'); },
		}));
		const terminal = this._register(new Button(toolbar, {
			...defaultButtonStyles, presentation: 'quiet', iconOnly: true, icon: Lxicon.dropDownButton,
			label: localize({ bundle: 'ash.workbench', key: 'chatWindow.terminalPosition' }, 'Terminal Position'),
			onClick: () => {
				terminal.domNode.setAttribute('aria-expanded', 'true');
				contextMenus.showContextMenu({
					getAnchor: () => terminal.domNode,
					getCheckedActionsRepresentation: () => 'radio',
					getActions: () => terminalPositions.map(position => {
						const { id, title } = getTerminalPositionAction(position);
						return { id, label: title.value, tooltip: '', enabled: true, checked: position === this.terminalPosition, run: () => run(id) };
					}),
					onHide: () => terminal.domNode.setAttribute('aria-expanded', 'false'),
				});
			},
		}));
		terminal.domNode.setAttribute('aria-haspopup', 'menu');
		terminal.domNode.setAttribute('aria-expanded', 'false');
		this._register(new Button(toolbar, {
			...defaultButtonStyles, presentation: 'quiet', icon: Lxicon.screenNormal, iconOnly: true,
			label: localize('sessions.window.return', 'Return to main window'), onClick: () => { void returnToMainWindow().catch(error => notifications.error(String(error))); },
		}));
		const pin = window.alwaysOnTop;
		if (pin) {
			const button = this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'quiet', iconOnly: true, icon: Lxicon.pinned,
				label: localize('sessions.window.pin', 'Keep window on top'),
				onClick: () => { void pin.set(!pin.value).catch(error => notifications.error(String(error))); },
			}));
			const update = (value: boolean) => button.domNode.setAttribute('aria-pressed', String(value));
			update(pin.value);
			this._register(pin.onDidChange(update));
		}
	}

	updateLayoutControls(canToggle: boolean, inputOnly: boolean, terminalPosition: ChatWindowTerminalPosition): void {
		this.terminalPosition = terminalPosition;
		this.conversation.domNode.hidden = !canToggle;
		this.conversation.label = inputOnly
			? localize({ bundle: 'ash.workbench', key: 'chatWindow.showConversation' }, 'Show Chat Conversation')
			: localize({ bundle: 'ash.workbench', key: 'chatWindow.showInputOnly' }, 'Show Chat Input Only');
		this.conversation.domNode.setAttribute('aria-expanded', String(!inputOnly));
	}

	// Conversation titles are supplied by the opener and have no editor title template.
	updateProperties(): void { }
	registerVariables(): void { }

	/** The opener retains the conversation; this host owns only its mount presentation. */
	setTitle(title: string): void {
		this.title.textContent = this.title.title = this.window.window.document.title = title;
		this.window.container.setAttribute('aria-label', title);
	}
}
