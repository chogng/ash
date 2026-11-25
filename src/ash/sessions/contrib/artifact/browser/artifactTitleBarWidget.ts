import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Menus } from '../../../browser/menus.js';
import { getActiveElement, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { Action, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../../platform/actions/browser/toolbar.js';
import { type MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { renderInlineRenameInput, showInlineRenameInput } from '../../../browser/parts/titlebar/inlineRenameInput.js';
import { TitleMenuActionViewItem } from '../../../browser/parts/titlebar/titleMenuActionViewItem.js';
import { isArtifactName } from '../common/artifactWorkspace.js';

type RenameArtifact = (name: string) => Promise<void>;

export class ArtifactTitleBarWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly heading: HTMLElement;
	private readonly titleText: HTMLElement;
	private readonly titleMenuHost: HTMLElement;
	private readonly titleMenu: TitleMenuActionViewItem;
	private readonly renameInput: HTMLInputElement;
	private getTitleActions: (() => readonly IAction[]) | undefined;
	private getRename: (() => RenameArtifact | undefined) | undefined;
	private edit: { readonly title: string; readonly rename: RenameArtifact; saving: boolean; } | undefined;
	private hasTitleActions = false;
	private title = '';
	private readonly actionsHost: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private contentActions: readonly IAction[] = [];

	constructor(
		document: Document,
		ariaLabel: string,
		menu: MenuId | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this.domNode = h(document, 'header', { className: 'ash-sessions-titlebar-editor-page' });
		this._register(toDisposable(() => this.domNode.remove()));
		this.heading = h(document, 'h1');
		this.titleText = h(document, 'span', { className: 'ash-artifact-title-text' });
		this.titleMenuHost = h(document, 'span', { properties: { hidden: true } });
		this.heading.append(this.titleText, this.titleMenuHost);
		const titleAction = this._register(new Action('sessions.artifacts.titleActions'));
		this.titleMenu = this._register(new TitleMenuActionViewItem(titleAction, () => this.getTitleActions?.() ?? [],
			contextMenus, () => this.getRename?.() ? () => this.beginRename() : undefined));
		this.titleMenu.render(this.titleMenuHost);
		this._register(hoverService.setupDelayedHover(this.titleMenu.element, () => ({ content: this.title })));
		this.renameInput = renderInlineRenameInput(this.heading, {
			label: localize('sessions.artifacts.renameTitle', 'Rename artifact'),
			onAccept: () => { void this.saveRename(); },
			onCancel: () => { if (!this.edit?.saving) this.finishRename(true); },
			onBlur: () => { if (!this.edit?.saving) this.finishRename(false); },
		}, this._register(new DisposableStore()));
		this.actionsHost = h(document, 'div', { className: 'ash-artifact-title-actions' });
		this.domNode.append(this.heading, this.actionsHost);
		const options = {
			ariaLabel, presentation: 'inherit-foreground' as const, highlightToggledItems: true,
			actionViewItemProvider: (action: IAction, options: ActionViewItemOptions) =>
				action instanceof SubmenuAction && action.id === 'sessions.artifacts.export'
					? new DropdownMenuActionViewItem(action, action.actions, contextMenus, options)
					: undefined,
		};
		this.toolbar = this._register(menu
			? instantiationService.createInstance(MenuWorkbenchToolBar, this.actionsHost, menu, { ...options, contextKeyService: contextKeys })
			: new WorkbenchToolBar(this.actionsHost, contextMenus, options));
		this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.actionsHost, Menus.EditorPartLayout, {
			ariaLabel: localize('sessions.layout.editorActions', 'Editor layout'),
			presentation: 'inherit-foreground',
			contextKeyService: contextKeys,
			actionViewItemProvider: (action, options) => new ButtonActionViewItem(action, {
				...options, iconOnly: action.id !== 'sessions.toggleSessionPart' || !action.checked,
			}),
		} satisfies IMenuWorkbenchToolBarOptions));
	}

	setTitle(title: string): void {
		if (this.title === title) return;
		this.title = title;
		this.updateTitle();
		this.heading.title = title;
	}

	setTitleActions(getActions: (() => readonly IAction[]) | undefined, getRename?: () => RenameArtifact | undefined): void {
		this.resetTitleInteraction();
		this.getTitleActions = getActions;
		this.getRename = getRename;
		this.refreshTitleActions();
	}

	refreshTitleActions(): void {
		this.hasTitleActions = (this.getTitleActions?.().length ?? 0) > 0;
		if (!this.hasTitleActions) this.closeTitleMenu();
		this.updateTitle();
	}

	private updateTitle(): void {
		this.titleText.hidden = !!this.edit || this.hasTitleActions;
		this.titleMenuHost.hidden = !!this.edit || !this.hasTitleActions;
		this.titleText.textContent = this.titleText.hidden ? '' : this.title;
		this.titleMenu.setLabel(this.titleMenuHost.hidden ? '' : this.title);
	}

	closeTitleMenu(): void {
		this.titleMenu.hide();
	}

	resetTitleInteraction(): void {
		this.closeTitleMenu();
		this.finishRename(false);
	}

	beginRename(): void {
		const rename = this.getRename?.();
		if (!rename || this.edit) return;
		this.closeTitleMenu();
		this.edit = { title: this.title, rename, saving: false };
		showInlineRenameInput(this.renameInput, this.title);
		this.updateTitle();
	}

	private finishRename(restoreFocus: boolean): void {
		if (!this.edit) return;
		this.edit = undefined;
		this.updateTitle();
		if (restoreFocus && !this.titleMenuHost.hidden) this.titleMenu.focus();
		this.renameInput.hidden = true;
	}

	private async saveRename(): Promise<void> {
		const edit = this.edit;
		if (!edit || edit.saving) return;
		const input = this.renameInput;
		const name = input.value.trim();
		if (!isArtifactName(name)) {
			input.setCustomValidity(localize('sessions.artifacts.invalidName', 'Enter a name of up to 200 characters.'));
			input.reportValidity();
			return;
		}
		if (name === edit.title) {
			this.finishRename(true);
			return;
		}
		edit.saving = true;
		input.readOnly = true;
		try {
			await edit.rename(name);
			this.accessibility.status(localize('sessions.artifacts.renamed', 'Artifact renamed to {0}.', name));
			if (this.edit === edit) this.finishRename(getActiveElement(input.ownerDocument) === input);
		} catch (error) {
			this.notifications.error(toErrorMessage(error));
			if (this.edit === edit) {
				edit.saving = false;
				input.readOnly = false;
				if (getActiveElement(input.ownerDocument) !== input) this.finishRename(false);
			}
		}
	}

	setActions(actions: readonly IAction[], exports: readonly IAction[] = []): void {
		this.contentActions = exports.length
			? [...actions, new SubmenuAction('sessions.artifacts.export', localize('sessions.artifacts.export', 'Export'), exports)]
			: actions;
		this.updateActions();
	}

	private updateActions(): void {
		if (this.toolbar instanceof MenuWorkbenchToolBar) this.toolbar.setTrailingActions(this.contentActions);
		else this.toolbar.setActions(this.contentActions);
	}

	setActionsVisible(visible: boolean): void {
		this.actionsHost.hidden = !visible;
	}

	protected override disposeCore(): void {
		this.resetTitleInteraction();
		super.disposeCore();
	}
}
