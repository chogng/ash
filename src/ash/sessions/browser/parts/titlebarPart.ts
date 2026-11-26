import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService, type IColorTheme } from '../../../platform/theme/common/themeService.js';
import { ColorScheme, isDarkColorScheme } from '../../../platform/theme/common/theme.js';
import './media/titlebarpart.css';
import './titlebar/media/menubarControl.css';
import { sessionsConversationBackground } from '../../common/theme.js';
import { addDisposableListener, h, isEditableElement, isElement, type IDimension } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../base/browser/scheduler.js';
import { Color } from '../../../base/common/color.js';
import { environment } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { MenuWorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../platform/actions/browser/toolbar.js';
import { WebTitlebarPart, type ITitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import type { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { BrowserMenubarControl } from '../../../workbench/browser/parts/titlebar/menubarControl.js';
import { activityBarPositionCommandPrefix, Menus } from '../menus.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { WindowModeControl } from './titlebar/windowModeControl.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsEntryShowsWorkspaceModeControlContext, SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { autorun, observableFromEvent } from '../../../base/common/observable.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { SideBarVisibleContext } from '../../../workbench/common/contextkeys.js';
import { titleBarBackground } from '../../../workbench/common/theme.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { SHOW_CHAT_WORKSPACE_COMMAND } from '../../common/chatWorkspace.js';
import { SessionsWindowTitlebarHeight } from '../../../platform/window/common/window.js';

/** The titlebar surface to the right of the sidebar also backs the window controls. */
export function getSessionsTitlebarBackground(theme: IColorTheme): string | undefined {
	const shell = theme.getColor(titleBarBackground);
	const background = theme.colorScheme === ColorScheme.Light ? theme.getColor(sessionsConversationBackground) ?? shell : shell;
	if (!background) return undefined;
	if (background.isOpaque()) return Color.Format.CSS.formatHex(background);

	// Composite translucent custom colors over the Sessions shell before handing them to Electron.
	const workbench = theme.getColor('workbench.background') ?? (isDarkColorScheme(theme.colorScheme) ? Color.black : Color.white);
	return Color.Format.CSS.formatHex(background.flatten(shell ?? workbench, workbench));
}

export function getSessionsTitlebarPart(titleService: ITitleService, container: HTMLElement): TitlebarPart {
	const part = titleService.getPart(container);
	if (!(part instanceof TitlebarPart)) throw new Error('The Sessions window requires a Sessions titlebar');
	return part;
}

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WebTitlebarPart implements ITitlebarPart {
	readonly onMenubarVisibilityChange = Event.None;

	// This part presents the active session, independent of the editor window title template.
	updateProperties(): void { }
	registerVariables(): void { }

	private readonly activityActions: MenuWorkbenchToolBar;
	private readonly leftControls: HTMLElement;
	private readonly rightControls: HTMLElement;
	private readonly pageContent: HTMLElement;
	private readonly sessionContent: HTMLElement;
	private readonly editorRegion: HTMLElement;
	private readonly sidePaneActions: MenuWorkbenchToolBar;
	private readonly layoutActions: MenuWorkbenchToolBar;
	private sidebarMinimumWidth = 0;
	private hostedTabWidth = 0;
	private readonly editorRegionSpaceChanged = this._register(new Emitter<void>());
	public readonly onDidChangeEditorRegionSpace = this.editorRegionSpaceChanged.event;
	private readonly relayoutActions: AnimationFrameScheduler;

	/** Intrinsic left controls, their gaps and the sidebar-aligned outer insets. */
	public get minimumSidebarWidth(): number { return this.sidebarMinimumWidth; }

	public override get minimumHeight(): number {
		return Math.max(super.minimumHeight, SessionsWindowTitlebarHeight);
	}

	constructor(
		container: HTMLElement,
		presentation: 'application-menu' | 'actions-only',
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(container, themeService, storageService, 0);
		const ownerWindow = container.ownerDocument.defaultView!;
		const pixels = (value: string): number => Number.parseFloat(value) || 0;
		this.domNode.classList.add('ash-sessions-titlebar');
		this.updateStyles();
		const showContextMenu = (event: MouseEvent | KeyboardEvent): void => {
			if (event.defaultPrevented || !isElement(event.target) || isEditableElement(event.target)) return;
			const anchor = event.type === 'contextmenu'
				? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: ownerWindow }
				: event.target;
			event.preventDefault();
			event.stopPropagation();
			contextMenus.showContextMenu({
				getAnchor: () => anchor,
				menuId: Menus.TitleBarContext,
				contextKeyService: contextKeys.getContextKeyService(event.target),
				autoSelectFirstItem: event.type === 'keydown',
				getCheckedActionsRepresentation: action => action.id.startsWith(activityBarPositionCommandPrefix) ? 'radio' : 'checkbox',
			});
		};
		this._register(addDisposableListener(this.domNode, 'contextmenu', showContextMenu));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) showContextMenu(event);
		}));
		const left = this.leftControls = h(container.ownerDocument, 'div');
		left.className = 'ash-sessions-titlebar-left';
		this.contentDomNode.append(left);
		const titlebarContext = this._register(contextKeys.createScoped(left));
		const menuScope = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, titlebarContext])));
		const menubar = this._register(menuScope.createInstance(BrowserMenubarControl, left, {
			presentation,
			applicationMenuId: Menus.MenubarMainMenu,
			titlebarMenuId: Menus.TitleBarLeftLayout,
		}));
		menubar.domNode.classList.add('ash-sessions-titlebar-actions', 'ash-titlebar-interactive-region');
		const modeKeys = new Set([SessionsWorkspaceModeContext.key]);
		const modeChanged: Event<unknown> = listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKeys)) listener(event);
		});
		const activeMode = observableFromEvent(this, modeChanged, () =>
			contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code' ? 'code' as const : 'agents' as const);
		this._register(autorun(reader => {
			this.domNode.classList.toggle('ash-sessions-titlebar-code', activeMode.read(reader) === 'code');
		}));
		const modeHost = h(container.ownerDocument, 'div');
		modeHost.className = 'ash-sessions-workspace-mode';
		left.append(modeHost);
		this._register(instantiationService.createInstance(WindowModeControl, modeHost, activeMode, {
			agents: environment.runtime === 'electron' ? SHOW_CHAT_WORKSPACE_COMMAND : 'sessions.open.chat',
			code: 'sessions.open.code',
		}));
		const updateModeVisibility = (): void => {
			const visible = contextKeys.getValue<boolean>(SideBarVisibleContext.key) !== false
				&& contextKeys.getValue<boolean>(SessionsEntryShowsWorkspaceModeControlContext.key) !== false;
			if (!visible && modeHost.contains(container.ownerDocument.activeElement)) {
				menubar.domNode.querySelector<HTMLElement>('[data-action-id="ash.sessions.toggleSidebar"] button')?.focus();
			}
			modeHost.hidden = !visible;
		};
		const modeVisibilityKeys = new Set([SideBarVisibleContext.key, SessionsEntryShowsWorkspaceModeControlContext.key]);
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeVisibilityKeys)) updateModeVisibility();
		}));
		updateModeVisibility();
		const updateSidebarMinimumWidth = (): void => {
			// Keep the expanded constraint while the mode control is hidden.
			if (modeHost.hidden) return;
			const children = Array.from(left.children).filter(child => ownerWindow.getComputedStyle(child).display !== 'none');
			const style = ownerWindow.getComputedStyle(left);
			const width = Math.ceil(children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
				+ Math.max(0, children.length - 1) * pixels(style.columnGap)
				+ pixels(style.paddingLeft) + pixels(style.paddingRight)
				+ pixels(ownerWindow.getComputedStyle(this.contentDomNode).paddingLeft)
				// Native window controls occupy titlebar padding outside the left controls.
				+ pixels(ownerWindow.getComputedStyle(this.domNode).paddingLeft));
			if (width !== this.sidebarMinimumWidth) {
				this.sidebarMinimumWidth = width;
				this.notifyConstraintsChanged();
			}
		};
		this._register(observeResize([this.contentDomNode, left, ...Array.from(left.children)], updateSidebarMinimumWidth, { box: 'border-box' }));
		updateSidebarMinimumWidth();
		this.pageContent = h(container.ownerDocument, 'div', { className: 'ash-sessions-titlebar-page-content' });
		this.sessionContent = h(container.ownerDocument, 'div', { className: 'ash-sessions-titlebar-session-content' });
		this.contentDomNode.append(this.pageContent, this.sessionContent);
		this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.sessionContent, Menus.CommandCenter, {
			ariaLabel: localize('sessions.titlebar.title', 'Session title'),
			contextKeyService: contextKeys,
			tabNavigation: 'each-action',
		}));
		const pageActions = this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.pageContent, Menus.TitleBarPageContent, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'titleBarPageActions' }, 'Page title actions'),
			contextKeyService: contextKeys,
			toolbarOptions: { primaryGroup: () => true },
		} satisfies IMenuWorkbenchToolBarOptions));
		const updatePageVisibility = (): void => {
			this.pageContent.hidden = pageActions.element.hidden;
			this.domNode.classList.toggle('has-page-content', !this.pageContent.hidden);
		};
		this._register(pageActions.onDidChangeMenuItems(updatePageVisibility));
		updatePageVisibility();
		const right = this.rightControls = h(container.ownerDocument, 'div');
		right.className = 'ash-sessions-titlebar-right';
		this.editorRegion = h(container.ownerDocument, 'div', { className: 'ash-sessions-titlebar-editor-region' });
		this.editorRegion.hidden = true;
		this.contentDomNode.append(right, this.editorRegion);
		const horizontalPadding = (element: HTMLElement): number => {
			const style = ownerWindow.getComputedStyle(element);
			return pixels(style.paddingLeft) + pixels(style.paddingRight);
		};
		const layoutActions = this.layoutActions = this._register(
			instantiationService.createInstance(MenuWorkbenchToolBar, right, Menus.TitleBarRightLayout, {
				ariaLabel: localize({ bundle: 'ash', key: 'windowMode.layout' }, 'Code layout'),
				presentation: 'inherit-foreground',
				highlightToggledItems: true,
				contextKeyService: contextKeys,

				responsiveBehavior: {
					enabled: true,
					observedElement: this.contentDomNode,
					getAvailableWidth: () => {
						const center = this.pageContent.hidden ? this.sessionContent : this.pageContent;
						const accounts = this.activityActions?.element;
						const accountsWidth = accounts?.getBoundingClientRect().width ?? 0;
						const accountsGap = accounts && accountsWidth ? pixels(ownerWindow.getComputedStyle(accounts).marginLeft) : 0;
						// With no conversation, tabs and layout actions share the remaining width.
						const sharesEditorWidth = !this.editorRegion.hidden && this.domNode.classList.contains('conversation-hidden') && this.domNode.classList.contains('has-editor-region');
						const editorRegionWidth = sharesEditorWidth ? this.hostedTabWidth : this.editorRegion.getBoundingClientRect().width;
						const centerWidth = center.getClientRects().length ? Math.max(horizontalPadding(center), pixels(ownerWindow.getComputedStyle(center).minWidth)) : 0;
						// Use the remaining titlebar space so growing the window can restore overflowed actions.
						const reservedWidth = horizontalPadding(this.contentDomNode) + left.getBoundingClientRect().width
							+ centerWidth + horizontalPadding(right)
							+ accountsWidth + accountsGap + editorRegionWidth + (this.sidePaneActions?.element.offsetWidth ?? 0);
						return Math.max(0, this.contentDomNode.clientWidth - reservedWidth);
					},
				},
			} satisfies IMenuWorkbenchToolBarOptions),
		);
		layoutActions.element.classList.add('ash-sessions-titlebar-actions');
		const activityActions = this.activityActions = this._register(instantiationService.createInstance(MenuWorkbenchToolBar, right, Menus.TitleBarAccounts, {
			ariaLabel: localize('workbench.accounts', 'Accounts'),
			presentation: 'inherit-foreground',
			contextKeyService: contextKeys,
		} satisfies IMenuWorkbenchToolBarOptions));
		this._register(activityActions.onDidChangeMenuItems(() => this.updateRightControlsVisibility()));
		this.sidePaneActions = this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.contentDomNode, Menus.TitleBarSidePane, {
			ariaLabel: localize({ bundle: 'ash', key: 'sessions.layout.sidePane' }, 'Side panel'),
			presentation: 'inherit-foreground',
			contextKeyService: contextKeys,
		}));
		this.sidePaneActions.element.classList.add('ash-sessions-titlebar-side-pane', 'ash-titlebar-interactive-region');
		this._register(layoutActions.onDidChangeMenuItems(() => this.updateRightControlsVisibility()));
		this.updateRightControlsVisibility();

		this.relayoutActions = this._register(new AnimationFrameScheduler(ownerWindow, () => layoutActions.relayout()));
		this._register(observeResize([this.contentDomNode, left, right, this.pageContent, this.sessionContent, this.editorRegion, this.sidePaneActions.element], () => {
			this.editorRegionSpaceChanged.fire();
			this.relayoutActions.schedule();
		}, { box: 'border-box' }));
	}

	public layoutEditorRegion(left: number | undefined, page: HTMLElement | undefined, conversationVisible: boolean, tabs: IDimension | undefined, setTabsHost: (host: HTMLElement | undefined) => void): void {
		const row = this.contentDomNode;
		const ownerWindow = row.ownerDocument.defaultView!;
		this.domNode.classList.toggle('conversation-hidden', !conversationVisible);
		this.domNode.classList.toggle('has-editor-region', left !== undefined && !page);

		const navigationEnd = this.leftControls.getBoundingClientRect().right;
		const rightControlsWidth = this.rightControls.getBoundingClientRect().width;
		const centerMinimum = parseFloat(ownerWindow.getComputedStyle(this.sessionContent).minWidth) || 0;
		const canFitBesideConversation = left !== undefined && left >= navigationEnd + centerMinimum + rightControlsWidth;
		const start = left !== undefined && (page || !conversationVisible || canFitBesideConversation)
			? Math.max(left, navigationEnd + (page ? rightControlsWidth : 0)) : undefined;
		const rowInset = parseFloat(ownerWindow.getComputedStyle(row).paddingRight) || 0;
		const trailingWidth = this.sidePaneActions.element.getBoundingClientRect().width;
		const width = start === undefined ? 0 : Math.max(0, row.getBoundingClientRect().right - start - rowInset - trailingWidth);
		this.domNode.classList.toggle('has-editor-region', width > 0 && !page);
		this.editorRegion.style.flexBasis = `${width}px`;

		const showRegion = width > 0 && (conversationVisible || !!page || !!tabs);
		if (showRegion) this.editorRegion.hidden = false;

		// Flex layout accounts for the actual window controls and any competing actions.
		const regionStyle = ownerWindow.getComputedStyle(this.editorRegion);
		const padding = (parseFloat(regionStyle.paddingLeft) || 0) + (parseFloat(regionStyle.paddingRight) || 0);
		const bounds = this.editorRegion.getBoundingClientRect();
		const tabWidth = tabs ? tabs.width + padding : 0;
		const hostTabs = !!tabs && !page && showRegion && tabWidth <= bounds.width && tabs.height <= bounds.height;
		// Return focused tabs to the group before hiding or replacing their old host.
		if (!hostTabs) setTabsHost(undefined);
		if (page && this.editorRegion.firstElementChild !== page) this.editorRegion.replaceChildren(page);
		else if (!page && this.domNode.classList.contains('has-editor-page-header')) this.editorRegion.firstElementChild?.remove();
		this.editorRegion.hidden = !showRegion || (!conversationVisible && !page && !hostTabs);
		this.domNode.classList.toggle('has-editor-page-header', !!page);
		if (hostTabs) setTabsHost(this.editorRegion);

		const hostedTabWidth = hostTabs ? tabWidth : 0;
		if (hostedTabWidth !== this.hostedTabWidth) {
			this.hostedTabWidth = hostedTabWidth;
			this.relayoutActions.schedule();
		}
	}

	public override updateStyles(): void {
		this.domNode.style.setProperty('--ash-sessions-titlebar-background', getSessionsTitlebarBackground(this.theme) ?? '');
	}

	private updateRightControlsVisibility(): void {
		// An empty controls area would still reserve its padding beside the editor region.
		this.rightControls.hidden = this.layoutActions.element.hidden && this.activityActions.getItemsLength() === 0;
	}
}
