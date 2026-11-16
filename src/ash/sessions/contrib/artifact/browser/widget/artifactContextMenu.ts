import type { ContextMenuAnchor, IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { ContextViewHideReason } from '../../../../../base/browser/ui/contextview/contextview.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { Menus } from '../../../../browser/menus.js';

interface ArtifactContextMenuOptions {
	getActions(): readonly IAction[];
	getActionsContext(): unknown;
	readonly menuClassName?: string;
	readonly getMenuActionViewItem?: IContextMenuDelegate['getActionViewItem'];
}

/** Shares menu contributions and presentation lifetime, leaving selection and commands with the editor. */
export class ArtifactContextMenu extends Disposable {
	private readonly presentation = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		private readonly options: ArtifactContextMenuOptions,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
	}

	public show(anchor: ContextMenuAnchor, restoreFocus: () => void): void {
		this.hide();
		const source = new CancellationTokenSource();
		this.presentation.value = source;
		const context = this.options.getActionsContext();
		this.contextMenus.showContextMenu({
			menuId: Menus.ArtifactContext,
			contextKeyService: this.contextKeys,
			menuActionOptions: { shouldForwardArgs: true },
			getAnchor: () => anchor,
			getActions: () => this.options.getActions(),
			getActionsContext: () => context,
			getMenuClassName: () => this.options.menuClassName ?? '',
			getActionViewItem: this.options.getMenuActionViewItem,
			iconPlacement: this.options.menuClassName ? 'leading-with-trailing-check' : 'trailing',
			cancellationToken: source.token,
			onHide: (_didCancel, reason) => {
				const cancelled = source.token.isCancellationRequested;
				if (this.presentation.value === source) this.presentation.clear();
				// Hiding a workspace or disposing it must not take focus back from the next editor.
				if (!cancelled && !this.isDisposed && (reason === undefined || reason === ContextViewHideReason.Escape || reason === ContextViewHideReason.Programmatic)) restoreFocus();
			},
		});
	}

	public hide(): void {
		this.presentation.value?.cancel();
		this.presentation.clear();
	}

	protected override disposeCore(): void {
		this.hide();
		super.disposeCore();
	}
}
