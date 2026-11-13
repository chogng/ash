import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService, type IColorTheme } from '../../../platform/theme/common/themeService.js';
import { ColorScheme, isDarkColorScheme } from '../../../platform/theme/common/theme.js';
import './media/titlebarpart.css';
import './titlebar/media/menubarControl.css';
import { sessionsConversationBackground } from '../../common/theme.js';
import { getWindowId, h } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../base/browser/scheduler.js';
import { Color } from '../../../base/common/color.js';
import type { ActionViewItemProvider } from '../../../base/browser/ui/actionbar/actionbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { environment } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { WebTitlebarPart, type ITitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import type { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { BrowserMenubarControl } from '../../../workbench/browser/parts/titlebar/menubarControl.js';
import { Menus } from '../menus.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { WindowModeControl } from './titlebar/windowModeControl.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { IsNewSessionContext, SessionsEntryShowsWorkspaceModeControlContext, SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { autorun, observableFromEvent, type IObservable } from '../../../base/common/observable.js';
import { Event } from '../../../base/common/event.js';
import { SideBarVisibleContext } from '../../../workbench/common/contextkeys.js';
import { titleBarBackground } from '../../../workbench/common/theme.js';
import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { SHOW_CHAT_WORKSPACE_COMMAND } from '../../contrib/chat/common/constants.js';

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

	private readonly activityActions: WorkbenchToolBar;
	private readonly leftControls: HTMLElement;
	private readonly pageContent: HTMLElement;
	private readonly sessionContent: HTMLElement;
	private readonly editorHeaders: HTMLElement;
	private readonly layoutActions: MenuWorkbenchToolBar;
	private activityActionViewItemProvider: ActionViewItemProvider | undefined;
	private sidebarMinimumWidth = 0;

	/** Intrinsic left controls, their gaps and the sidebar-aligned outer insets. */
	public get minimumSidebarWidth(): number { return this.sidebarMinimumWidth; }

	public override get minimumHeight(): number {
		// Align this row with the whole-pixel center of macOS inset window buttons.
		return environment.runtime === 'electron' && environment.os === 'mac' ? Math.max(super.minimumHeight, 36) : super.minimumHeight;
	}

	constructor(
		container: HTMLElement,
		presentation: 'application-menu' | 'actions-only',
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IActionViewItemService presentations: IActionViewItemService,
	) {
		super(container, themeService, storageService, 0);
		const ownerWindow = container.ownerDocument.defaultView!;
		const pixels = (value: string): number => Number.parseFloat(value) || 0;
		this.domNode.classList.add('ash-sessions-titlebar');
		this.updateStyles();
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
		const draftKeys = new Set([IsNewSessionContext.key]);
		const updateDraftState = (): void => {
			this.domNode.classList.toggle('is-new-session', contextKeys.getValue(IsNewSessionContext.key) === true);
		};
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(draftKeys)) updateDraftState();
		}));
		updateDraftState();
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
		const pageActions = this._register(new MenuWorkbenchToolBar(this.pageContent, menuService, contextMenus, Menus.TitleBarPageContent, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'titleBarPageActions' }, 'Page title actions'),
			contextKeyService: contextKeys,
			toolbarOptions: { primaryGroup: () => true },
			actionViewItemProvider: (action, options) => presentations.lookUp(Menus.TitleBarPageContent, action.id)?.(
				action, options, instantiationService, getWindowId(ownerWindow) ?? 0,
			),
		}));
		const updatePageVisibility = (): void => {
			this.pageContent.hidden = pageActions.element.hidden;
			this.domNode.classList.toggle('has-page-content', !this.pageContent.hidden);
		};
		this._register(pageActions.onDidChangeMenuItems(updatePageVisibility));
		this._register(presentations.onDidChange(menu => {
			if (menu === Menus.TitleBarPageContent) {
				pageActions.refresh();
				updatePageVisibility();
			}
		}));
		updatePageVisibility();
		const right = h(container.ownerDocument, 'div');
		right.className = 'ash-sessions-titlebar-right';
		this.editorHeaders = h(container.ownerDocument, 'div', { className: 'ash-sessions-titlebar-editor-headers' });
		this.editorHeaders.hidden = true;
		this.contentDomNode.append(right, this.editorHeaders);
		const horizontalPadding = (element: HTMLElement): number => {
			const style = ownerWindow.getComputedStyle(element);
			return pixels(style.paddingLeft) + pixels(style.paddingRight);
		};
		const layoutActions = this.layoutActions = this._register(
			new MenuWorkbenchToolBar(right, menuService, contextMenus, Menus.TitleBarRightLayout, {
				ariaLabel: localize({ bundle: 'ash', key: 'windowMode.layout' }, 'Code layout'),
				presentation: 'inherit-foreground',
				highlightToggledItems: true,
				contextKeyService: contextKeys,
				actionViewItemProvider: (action, options) => presentations.lookUp(Menus.TitleBarRightLayout, action.id)?.(
					action, options, instantiationService, getWindowId(ownerWindow) ?? 0,
				),
				responsiveBehavior: {
					enabled: true,
					observedElement: this.contentDomNode,
					getAvailableWidth: () => {
						const center = this.pageContent.hidden ? this.sessionContent : this.pageContent;
						const accounts = this.activityActions?.element;
						const accountsWidth = accounts?.getBoundingClientRect().width ?? 0;
						const accountsGap = accounts && accountsWidth ? pixels(ownerWindow.getComputedStyle(accounts).marginLeft) : 0;
						const editorHeaderWidth = this.editorHeaders.getBoundingClientRect().width;
						const titleMinimum = editorHeaderWidth ? pixels(ownerWindow.getComputedStyle(center).minWidth) : 0;
						// Use the remaining titlebar space so growing the window can restore overflowed actions.
						const reservedWidth = horizontalPadding(this.contentDomNode) + left.getBoundingClientRect().width
							+ Math.max(horizontalPadding(center), titleMinimum) + horizontalPadding(right)
							+ accountsWidth + accountsGap + editorHeaderWidth;
						return Math.max(0, this.contentDomNode.clientWidth - reservedWidth);
					},
				},
			}),
		);
		layoutActions.element.classList.add('ash-sessions-titlebar-actions');
		this._register(presentations.onDidChange(menu => {
			if (menu === Menus.TitleBarRightLayout) layoutActions.refresh();
		}));
		this.activityActions = this._register(new WorkbenchToolBar(right, contextMenus, {
			ariaLabel: localize('workbench.accounts', 'Accounts'),
			presentation: 'inherit-foreground',
			actionViewItemProvider: (action, options) => this.activityActionViewItemProvider?.(action, options),
		}));
		const relayoutActions = this._register(new AnimationFrameScheduler(ownerWindow, () => layoutActions.relayout()));
		this._register(observeResize([left, this.pageContent, this.sessionContent, this.activityActions.element, this.editorHeaders], () => relayoutActions.schedule(), { box: 'border-box' }));
	}

	public layoutEditorHeaders(left: number | undefined, page: HTMLElement | undefined, setToolHost: (host: HTMLElement | undefined) => void): void {
		let width = 0;
		if (left !== undefined) {
			const controlsEnd = this.leftControls.getBoundingClientRect().right;
			const accountsWidth = this.activityActions.element.offsetWidth;
			if (page) {
				// In a single-pane layout, the page starts behind the window navigation controls.
				const actionWidth = this.layoutActions.element.hidden ? 0 : this.minimumHeight;
				left = Math.max(left, controlsEnd + accountsWidth + actionWidth);
			}
			// A narrow Code split still needs its conversation title menu and tool overflow trigger.
			if (page || left - controlsEnd >= this.minimumHeight * 2 + accountsWidth) {
				const row = this.contentDomNode;
				const rightInset = parseFloat(row.ownerDocument.defaultView!.getComputedStyle(row).paddingRight);
				width = Math.max(0, row.getBoundingClientRect().right - rightInset - left);
			}
		}
		const dockTools = width > 0 && !page;
		// Return the focused row to its group before hiding the titlebar slot.
		if (!dockTools) setToolHost(undefined);
		const oldPage = this.editorHeaders.firstElementChild;
		if (page && oldPage !== page) this.editorHeaders.replaceChildren(page);
		else if (!page && this.domNode.classList.contains('has-editor-page-header')) oldPage?.remove();
		this.editorHeaders.hidden = width === 0;
		this.domNode.classList.toggle('has-tool-headers', dockTools);
		this.domNode.classList.toggle('has-editor-page-header', !!page);
		this.editorHeaders.style.flexBasis = `${width}px`;
		if (dockTools) setToolHost(this.editorHeaders);
	}

	public override updateStyles(): void {
		this.domNode.style.setProperty('--ash-sessions-titlebar-background', getSessionsTitlebarBackground(this.theme) ?? '');
	}

	public setSessionContent(content: HTMLElement, menuOpen: IObservable<boolean>): IDisposable {
		this.sessionContent.replaceChildren(content);
		const menuState = autorun(reader => {
			if (content.parentElement === this.sessionContent) {
				this.sessionContent.classList.toggle('session-menu-open', menuOpen.read(reader));
			}
		});
		return toDisposable(() => {
			menuState.dispose();
			if (content.parentElement === this.sessionContent) {
				this.sessionContent.classList.remove('session-menu-open');
				content.remove();
			}
		});
	}

	public setActivityActions(actions: readonly IAction[], actionViewItemProvider: ActionViewItemProvider): void {
		this.activityActionViewItemProvider = actionViewItemProvider;
		this.activityActions.setActions([], [], actions);
	}
}
