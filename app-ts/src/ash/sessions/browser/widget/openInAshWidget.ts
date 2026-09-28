import { Button } from '../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';

/** The Code half of the Sessions window's Chat / Code control. */
export class OpenInAshWidget extends Disposable {
	readonly button: Button;

	constructor(container: HTMLElement, showCodePage: () => void) {
		super();
		const label = localize('sessions.mode.code', 'Code');
		this.button = this._register(new Button(container, {
			label,
			icon: Lxicon.code,
			iconOnly: true,
			ariaLabel: label,
			title: label,
			onClick: showCodePage,
		}));
		this.button.domNode.setAttribute('aria-current', 'false');
	}
}
