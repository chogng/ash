import './commandCenterControl.css';
import { h } from '../../../../base/browser/dom.js';
import { setAriaAttribute } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize, type ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { WindowTitle } from './windowTitle.js';
import { getButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IAction } from '../../../../base/common/actions.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';

interface ICommandCenterControlOptions {
	readonly showTitle: boolean;
	readonly ariaLabel: string;
	readonly navigationActions: () => readonly IAction[];
	readonly onClick: () => void;
}

export class CommandCenterControl extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly button: Button;

	constructor(
		container: HTMLElement,
		windowTitle: Pick<WindowTitle, 'value' | 'onDidChange'>,
		localizationService: ILocalizationService | undefined,
		options: ICommandCenterControlOptions | undefined,
		@IQuickInputService private readonly quickInput: IQuickInputService,
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
		const navigation = options
			? this._register(new WorkbenchToolBar(navigationDomNode, contextMenuService, { presentation: 'inherit-foreground' }))
			: this._register(new MenuWorkbenchToolBar(navigationDomNode, menuService, contextMenuService, MenuId.CommandCenter, { presentation: 'inherit-foreground' }));
		this.domNode.classList.toggle('ash-titlebar-command-center-custom', options !== undefined);

		const label = () => localize(localizationService, { bundle: 'ash.regions', key: 'searchCommands' }, 'Search commands');
		this.button = this._register(new Button(this.domNode, {
			label: label(),
			...getButtonStyles({ buttonSecondaryForeground: 'commandCenter.foreground' }),
			ariaLabel: options?.ariaLabel ?? label(),
			icon: Lxicon.search,
			onClick: () => {
				if (options) options.onClick();
				else this.quickInput.quickAccess.show();
			},
		}));
		this.button.toggleClassName('ash-titlebar-command-center-button', true);
		const updateTitle = (): void => {
			if (options?.showTitle) this.button.label = windowTitle.value;
			if (options) navigation.setActions(options.navigationActions());
			this.button.setTitle(windowTitle.value);
			this.button.domNode.setAttribute('aria-description', windowTitle.value);
		};
		this._register(windowTitle.onDidChange(updateTitle));
		updateTitle();
		setAriaAttribute(this.button.domNode, 'haspopup', 'dialog');
		setAriaAttribute(this.button.domNode, 'expanded', false);
		const updateVisibility = (visible: boolean): void => {
			this.button.toggleClassName('active', visible);
			setAriaAttribute(this.button.domNode, 'expanded', visible);
		};
		if (options) {
			this._register(this.quickInput.onShow(() => updateVisibility(true)));
			this._register(this.quickInput.onHide(() => updateVisibility(false)));
		} else {
			this._register(this.quickInput.quickAccess.onDidChangeVisibility(updateVisibility));
		}
	}
}
