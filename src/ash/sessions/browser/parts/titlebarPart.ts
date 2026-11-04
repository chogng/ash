import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService, type IColorTheme } from '../../../platform/theme/common/themeService.js';
import { ColorScheme, isDarkColorScheme } from '../../../platform/theme/common/theme.js';
import './media/titlebarpart.css';
import './titlebar/media/menubarControl.css';
import { sessionsConversationBackground } from '../../common/theme.js';
import { h } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { Color } from '../../../base/common/color.js';
import type { ActionViewItemProvider } from '../../../base/browser/ui/actionbar/actionbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { environment } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { WebTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { BrowserMenubarControl } from '../../../workbench/browser/parts/titlebar/menubarControl.js';
import { Menus } from '../menus.js';
import { createServiceIdentifier, IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { WindowModeControl } from './titlebar/windowModeControl.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
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

/** The window owns the titlebar host; the visible page owns its content and mount lifetime. */
export interface ISessionsTitlebarService {
	setPageContent(content: HTMLElement): IDisposable;
	setSessionContent(content: HTMLElement, menuOpen: IObservable<boolean>): IDisposable;
}

export const ISessionsTitlebarService = createServiceIdentifier<ISessionsTitlebarService>('sessionsTitlebarService');

/** Window chrome and primary product actions for the dedicated Sessions Workbench. */
export class TitlebarPart extends WebTitlebarPart implements ISessionsTitlebarService {
	private readonly activityActions: WorkbenchToolBar;
	private readonly pageContent: HTMLElement;
	private readonly sessionContent: HTMLElement;
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
	) {
		super(container, themeService, storageService, 0);
		this.domNode.classList.add('ash-sessions-titlebar');
		this.updateStyles();
		const left = h(container.ownerDocument, 'div');
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
		const modeHost = h(container.ownerDocument, 'div');
		modeHost.className = 'ash-sessions-workspace-mode';
		left.append(modeHost);
		this._register(instantiationService.createInstance(WindowModeControl, modeHost, activeMode, {
			agents: environment.runtime === 'electron' ? SHOW_CHAT_WORKSPACE_COMMAND : 'sessions.open.chat',
			code: 'sessions.open.code',
		}));
		const updateModeVisibility = (): void => {
			const visible = contextKeys.getValue<boolean>(SideBarVisibleContext.key) !== false;
			if (!visible && modeHost.contains(container.ownerDocument.activeElement)) {
				menubar.domNode.querySelector<HTMLElement>('[data-action-id="ash.sessions.toggleSidebar"] button')?.focus();
			}
			modeHost.hidden = !visible;
		};
		const sidebarKeys = new Set([SideBarVisibleContext.key]);
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(sidebarKeys)) updateModeVisibility();
		}));
		updateModeVisibility();
		const updateSidebarMinimumWidth = (): void => {
			// Keep the expanded constraint while the mode control is hidden with navigation.
			if (modeHost.hidden) return;
			const ownerWindow = container.ownerDocument.defaultView!;
			const children = Array.from(left.children).filter(child => ownerWindow.getComputedStyle(child).display !== 'none');
			const style = ownerWindow.getComputedStyle(left);
			const pixels = (value: string): number => Number.parseFloat(value) || 0;
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
		const right = h(container.ownerDocument, 'div');
		right.className = 'ash-sessions-titlebar-right';
		this.contentDomNode.append(right);
		const layoutActions = this._register(
			new MenuWorkbenchToolBar(right, menuService, contextMenus, Menus.TitleBarRightLayout, {
				ariaLabel: localize({ bundle: 'ash', key: 'windowMode.layout' }, 'Code layout'),
				presentation: 'inherit-foreground',
				highlightToggledItems: true,
				contextKeyService: contextKeys,
			}),
		);
		layoutActions.element.classList.add('ash-sessions-titlebar-actions');
		this.activityActions = this._register(new WorkbenchToolBar(right, contextMenus, {
			ariaLabel: localize('workbench.accounts', 'Accounts'),
			presentation: 'inherit-foreground',
			actionViewItemProvider: (action, options) => this.activityActionViewItemProvider?.(action, options),
		}));
	}

	public override updateStyles(): void {
		this.domNode.style.setProperty('--ash-sessions-titlebar-background', getSessionsTitlebarBackground(this.theme) ?? '');
	}

	public setPageContent(content: HTMLElement): IDisposable {
		this.pageContent.replaceChildren(content);
		return toDisposable(() => {
			if (content.parentElement === this.pageContent) { content.remove(); }
		});
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
