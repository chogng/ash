import './media/sessionsList.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { isContextMenuTriggerExpanded, type ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { setAriaAttribute } from '../../../../base/browser/ui/aria/aria.js';
import { createLoadingSpinner } from '../../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { AbstractDisposable, Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { MenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../../platform/actions/browser/toolbar.js';
import { MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import type { Project } from '../../../../platform/projects/common/projectService.js';
import { Menus } from '../../../browser/menus.js';
import { projectFolders } from '../../chat/browser/sessionWorkspaceProjects.js';
import { SessionListPreview } from './sessionHoverContent.js';

export function rowMoreAction(run: () => void, project: boolean): IAction {
	const label = project
		? localize('sessions.list.projectActions', 'More project actions')
		: localize('sessions.list.more', 'More actions');
	return { id: 'sessions.list.more', label, tooltip: label, icon: Lxicon.ellipsis, enabled: true, run };
}

export type SessionListSectionKind = 'section' | 'subgroup' | 'project';

export class SessionListSection extends Disposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	readonly preview: SessionListPreview | undefined;
	private readonly heading: HTMLElement;
	private readonly label: SessionListTitle;
	private readonly icon: HTMLElement;
	private readonly appearanceIcon: HTMLElement;
	private readonly actions: WorkbenchToolBar | undefined;
	private spinner: HTMLSpanElement | undefined;
	private open: (() => void) | undefined;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;
	private projectIcon: Icon | undefined;
	private collapsed = true;

	private get subgroup(): boolean { return this.kind !== 'section'; }
	get title(): string { return this.label.title; }
	get rowClassName(): string { return this.subgroup ? 'ash-sessions-list-subgroup-row' : 'ash-sessions-list-section-row'; }

	constructor(document: Document, key: string, private readonly kind: SessionListSectionKind, private readonly mode: 'chat' | 'code',
		toggle: (() => void) | undefined, projectId: string | undefined,
		@IContextMenuService contextMenus: IContextMenuService, @IInstantiationService instantiation: IInstantiationService,
		@ILabelService private readonly labels: ILabelService) {
		super();
		this.domNode = h(document, 'section', { className: this.subgroup ? 'ash-sessions-list-subgroup' : 'ash-sessions-list-section' });
		this.domNode.dataset.section = key;
		this.heading = h(document, toggle ? 'h3' : 'div', { className: 'ash-sessions-list-section-heading' });
		this.button = h(document, 'button', { className: 'ash-sessions-list-section-toggle' });
		this.button.type = 'button';
		this.preview = kind === 'project' ? this._register(new SessionListPreview(this.button, this.domNode)) : undefined;
		this.icon = h(document, 'span', { className: 'ash-sessions-list-section-icon', attributes: { 'aria-hidden': 'true' } });
		if (kind === 'project') this.icon.classList.add('ash-sessions-list-project-icon');
		this.appearanceIcon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.label = this._register(new SessionListTitle(document, 'ash-sessions-list-section-label', kind === 'project' ? 'fade' : 'static'));
		this.button.append(...(this.subgroup ? [this.icon, this.label.element] : [this.label.element, this.icon]));
		this.heading.append(this.button);
		this.domNode.append(this.heading);
		if (kind === 'project') {
			this.domNode.classList.add('ash-sessions-list-project-row');
			if (!toggle) this.domNode.classList.add('ash-sessions-list-project-navigation');
			const more = rowMoreAction(() => {
				if (this.moreButton) this.contextMenu?.(this.moreButton);
			}, true);
			if (projectId) {
				this.actions = this._register(instantiation.createInstance(MenuWorkbenchToolBar, this.domNode, Menus.SessionSectionToolbar, {
					ariaLabel: localize('projects.toolbar', 'Project actions'),
					tabNavigation: 'each-action',
					menuOptions: { arg: { projectId } },
					leadingActions: [more],
					actionViewItemProvider: (action, options) => action instanceof MenuItemAction
						? new MenuEntryActionViewItem(action, { ...options, iconOnly: true })
						: undefined,
				} satisfies IMenuWorkbenchToolBarOptions));
			} else {
				this.actions = this._register(new WorkbenchToolBar(this.domNode, contextMenus, { ariaLabel: more.label }));
				this.actions.setActions([more]);
			}
			this.actions.element.classList.add('ash-sessions-list-actions');
			this.actions.element.hidden = true;
			this.label.observeActions(this.actions.element);
			// The toolbar owns activation. A tree click would return focus to the row and dismiss the menu.
			this._register(addDisposableListener(this.actions.element, 'click', event => event.stopPropagation()));
		}
		this._register(addDisposableListener(this.button, 'click', event => {
			event.stopPropagation();
			if (this.open) this.open();
			else if (this.button.hasAttribute('aria-expanded')) toggle?.();
		}));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => {
			if (!this.contextMenu) return;
			event.preventDefault();
			event.stopPropagation();
			this.contextMenu({ x: event.clientX, y: event.clientY, targetWindow: getWindow(this.button) });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.stopPropagation();
				return;
			}
			if (this.contextMenu && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
				event.preventDefault();
				event.stopPropagation();
				const more = this.moreButton;
				this.contextMenu(more && event.target === more ? more : this.button);
			}
		}));
	}

	updateCodeProjectPreview(hoverService: IHoverService | undefined, project: Project): void {
		this.preview?.update(hoverService, {
			kind: 'project',
			title: project.name,
			details: { conversationCount: project.sessionCount, updatedAt: project.updatedAtMs },
			paths: {
				folders: projectFolders(project),
				formatPath: folder => ({
					label: this.labels.getUriLabel(folder),
					basename: this.labels.getUriBasenameLabel(folder),
				}),
			},
		});
	}

	setContextMenu(menu: ((anchor: ContextMenuAnchor) => void) | undefined): void {
		this.contextMenu = menu;
		if (this.actions) this.actions.element.hidden = !menu;
		setAriaAttribute(this.button, 'haspopup', menu ? 'menu' : undefined);
		const more = this.moreButton;
		if (menu && more) {
			setAriaAttribute(more, 'haspopup', 'menu');
			setAriaAttribute(more, 'expanded', isContextMenuTriggerExpanded(this.domNode, more));
		}
	}

	get moreButton(): HTMLButtonElement | null {
		return this.actions?.element.querySelector('[data-action-id="sessions.list.more"] button') ?? null;
	}

	getMenuTrigger(anchor: ContextMenuAnchor): HTMLButtonElement | undefined {
		if (anchor === this.button) return this.button;
		const more = this.moreButton;
		return more && anchor === more ? more : undefined;
	}

	setLoading(loading: boolean): void {
		this.button.setAttribute('aria-busy', String(loading));
		this.icon.classList.toggle('loading', loading);
		if (loading) {
			this.spinner ??= createLoadingSpinner(this.button.ownerDocument);
			if (!this.spinner.parentElement) this.icon.append(this.spinner);
		} else {
			this.spinner?.remove();
		}
	}

	update(title: string, options?: { readonly open?: () => void; readonly actionLabel?: string; readonly icon?: Icon; readonly color?: string; }): void {
		this.open = options?.open;
		this.label.setTitle(title);
		if (!this.preview?.registered) this.button.title = options?.actionLabel ?? title;
		if (options?.actionLabel) this.button.setAttribute('aria-label', options.actionLabel);
		else this.button.removeAttribute('aria-label');
		const customIcon = options?.icon;
		const color = options?.color ?? '';
		if (this.kind === 'project') {
			this.projectIcon = customIcon;
			this.icon.style.color = color;
			this.renderIcon();
			return;
		}
		this.icon.style.color = customIcon ? '' : color;
		if (customIcon) {
			if (this.appearanceIcon.firstElementChild?.getAttribute('data-ash-icon-id') !== customIcon.id) {
				this.appearanceIcon.replaceChildren();
				appendIcon(customIcon, this.appearanceIcon);
			}
			this.appearanceIcon.style.color = color;
			if (!this.appearanceIcon.parentElement) this.label.element.before(this.appearanceIcon);
		} else {
			this.appearanceIcon.remove();
		}
	}

	renderCollapse(collapsed: boolean, collapsible: boolean): void {
		this.collapsed = collapsed;
		if (!collapsible && !(this.kind === 'project' && this.contextMenu)) {
			if (this.label.element.parentElement !== this.heading) {
				this.heading.classList.add('ash-sessions-list-section-static');
				this.heading.replaceChildren(...(this.subgroup ? [this.icon, this.label.element] : [this.label.element]));
			}
			if (!this.subgroup) return;
		} else {
			if (this.button.parentElement !== this.heading) {
				this.button.append(...(this.subgroup ? [this.icon, this.label.element] : [this.label.element, this.icon]));
				this.heading.replaceChildren(this.button);
				this.heading.classList.remove('ash-sessions-list-section-static');
			}
		}
		if (collapsible) this.button.setAttribute('aria-expanded', String(!collapsed));
		else this.button.removeAttribute('aria-expanded');
		this.renderIcon();
	}

	private renderIcon(): void {
		const chevron = this.collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		let icon = chevron;
		if (this.kind === 'project' && this.mode === 'chat') {
			icon = this.collapsed ? Lxicon.projects : Lxicon.projectsFilled;
		} else if (this.subgroup) {
			icon = this.collapsed ? Lxicon.folder : Lxicon.folderOpened;
		}
		icon = this.projectIcon ?? icon;
		const showChevron = this.kind === 'project' && this.button.hasAttribute('aria-expanded');
		const glyphs = this.icon.querySelectorAll(':scope > .ash-icon');
		if (glyphs[0]?.getAttribute('data-ash-icon-id') !== icon.id
			|| glyphs[1]?.getAttribute('data-ash-icon-id') !== (showChevron ? chevron.id : undefined)) {
			for (const glyph of glyphs) glyph.remove();
			appendIcon(icon, this.icon);
			if (showChevron) {
				appendIcon(chevron, this.icon).classList.add('ash-sessions-list-project-chevron');
			}
		}
	}

	protected override disposeCore(): void {
		super.disposeCore();
		this.domNode.remove();
	}
}

export class SessionListTitle extends AbstractDisposable {
	readonly element: HTMLSpanElement;
	private readonly text: HTMLSpanElement;
	private readonly viewport: HTMLSpanElement | undefined;
	private resize: IDisposable | undefined;

	constructor(document: Document, className: string, behavior: 'static' | 'fade') {
		super();
		this.element = h(document, 'span', { className });
		this.text = this.element;
		if (behavior === 'fade') {
			this.viewport = h(document, 'span', { className: 'ash-sessions-list-title-viewport' });
			this.text = h(document, 'span');
			this.viewport.append(this.text);
			this.element.append(this.viewport);
		}
	}

	observeActions(actions: HTMLElement): void {
		const viewport = this.viewport!;
		this.resize = observeResize([viewport, actions], () => {
			const toolbar = actions.getBoundingClientRect();
			if (toolbar.width > 0) {
				const title = this.element.getBoundingClientRect();
				const rtl = getWindow(actions).getComputedStyle(actions).direction === 'rtl';
				const overlap = rtl ? toolbar.right - title.left : title.right - toolbar.left;
				this.element.style.setProperty('--sessions-row-actions-space', `max(0px, ${overlap}px + var(--ash-spacing-size40))`);
			} else {
				this.element.style.removeProperty('--sessions-row-actions-space');
			}
			this.updateTitleOverflow(viewport);
		});
	}

	get title(): string {
		return this.text.textContent ?? '';
	}

	setTitle(title: string): void {
		if (this.title === title) {
			return;
		}
		this.text.textContent = title;
		if (this.viewport?.isConnected) {
			this.updateTitleOverflow(this.viewport);
		}
	}

	private updateTitleOverflow(viewport: HTMLElement): void {
		const width = viewport.getBoundingClientRect().width;
		const overflow = this.text.getBoundingClientRect().width - width;
		const hasOverflow = width > 0 && overflow > 0;
		viewport.classList.toggle('ash-sessions-list-title-overflows', hasOverflow);
		if (hasOverflow) {
			viewport.style.setProperty('--sessions-row-title-distance', `${overflow}px`);
			viewport.style.setProperty('--sessions-row-title-duration', `${Math.max(650, overflow * 32)}ms`);
		}
	}

	protected override disposeCore(): void {
		this.resize?.dispose();
	}
}
