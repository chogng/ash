import { h } from '../../../../base/browser/dom.js';
import { setAriaAttribute } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IQuickAccessController } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize, type ILocalizationService } from '../../../services/localization/common/localizationService.js';

export class CommandCenterControl extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly button: Button;

	constructor(
		container: HTMLElement,
		localizationService: ILocalizationService | undefined,
		@IQuickAccessController private readonly quickAccess: IQuickAccessController,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-titlebar-command-center ash-titlebar-interactive-region';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const navigationDomNode = h(container.ownerDocument, 'div');
		navigationDomNode.className = 'ash-titlebar-command-center-navigation ash-titlebar-interactive-region';
		this.domNode.append(navigationDomNode);
		this._register(new MenuWorkbenchToolBar(navigationDomNode, menuService, contextMenuService, MenuId.CommandCenter, {
			presentation: 'inherit-foreground',
		}));

		const label = () => localize(localizationService, { bundle: 'ash.regions', key: 'searchCommands' }, 'Search commands');
		this.button = this._register(new Button(this.domNode, {
			label: label(),
			ariaLabel: label(),
			title: label(),
			icon: Lxicon.search,
			onClick: () => {
				this.quickAccess.show();
			},
		}));
		this.button.toggleClassName('ash-titlebar-command-center-button', true);
		setAriaAttribute(this.button.domNode, 'haspopup', 'dialog');
		setAriaAttribute(this.button.domNode, 'expanded', false);
		this._register(this.quickAccess.onDidChangeVisibility(visible => {
			this.button.toggleClassName('active', visible);
			setAriaAttribute(this.button.domNode, 'expanded', visible);
		}));
		if (localizationService) {
			this._register(localizationService.onDidChange(() => {
				const text = label();
				this.button.label = text;
				this.button.domNode.setAttribute('aria-label', text);
				this.button.setTitle(text);
			}));
		}
	}
}
