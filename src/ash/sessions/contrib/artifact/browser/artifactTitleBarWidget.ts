import { h } from '../../../../base/browser/dom.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService, type MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';

export class ArtifactTitleBarWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly actionsHost: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		document: Document,
		ariaLabel: string,
		menu: MenuId | undefined,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(document, 'header', { className: 'ash-sessions-titlebar-editor-page' });
		this._register(toDisposable(() => this.domNode.remove()));
		this.heading = h(document, 'h1');
		this.actionsHost = h(document, 'div');
		this.domNode.append(this.heading, this.actionsHost);
		const options = { ariaLabel, presentation: 'inherit-foreground' as const, highlightToggledItems: true };
		this.toolbar = this._register(menu
			? new MenuWorkbenchToolBar(this.actionsHost, menus, contextMenus, menu, { ...options, contextKeyService: contextKeys })
			: new WorkbenchToolBar(this.actionsHost, contextMenus, options));
	}

	setTitle(title: string): void {
		this.heading.textContent = title;
		this.heading.title = title;
	}

	setActions(actions: readonly IAction[]): void {
		if (this.toolbar instanceof MenuWorkbenchToolBar) this.toolbar.setTrailingActions(actions);
		else this.toolbar.setActions(actions);
	}

	setActionsVisible(visible: boolean): void {
		this.actionsHost.hidden = !visible;
	}
}
