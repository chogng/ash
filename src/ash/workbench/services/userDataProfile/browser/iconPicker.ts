import './iconPicker.css';
import '../../../../base/browser/ui/button/button.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { IconSelectBox } from '../../../../base/browser/ui/icons/iconSelectBox.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getAllLxicons } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export class IconPicker extends Disposable {
	constructor(@IQuickInputService private readonly quickInput: IQuickInputService) {
		super();
	}

	/** Returns null on reset and undefined on dismissal. */
	async pickIcons(anchor: HTMLElement): Promise<Icon | null | undefined> {
		const resources = this._register(new DisposableStore());
		try {
			const document = anchor.ownerDocument;
			const window = getWindow(anchor);
			const title = localize('iconPicker.changeIcon', 'Change icon');
			const content = h(document, 'div', { className: 'ash-icon-picker', attributes: { role: 'dialog', 'aria-label': title } });
			const heading = h(document, 'h2', { className: 'ash-icon-picker-title' }, title);
			const grid = resources.add(new IconSelectBox({ icons: getAllLxicons(), inputBoxStyles: defaultInputBoxStyles, showIconInfo: true }, document));
			const reset = h(document, 'button', { className: 'ash-button ash-button-secondary', attributes: { type: 'button' } });
			reset.textContent = localize('iconPicker.resetIcon', 'Reset icon');
			const footer = h(document, 'div', { className: 'ash-icon-picker-footer' }, reset);
			content.append(heading, grid.domNode, footer);
			const widget = resources.add(this.quickInput.createQuickWidget());
			widget.anchor = anchor;
			widget.anchorPosition = 'below';
			widget.widget = content;
			const layout = () => grid.layout({
				width: Math.min(360, Math.max(0, window.innerWidth - 32)),
				height: Math.min(260, Math.max(0, window.innerHeight - 96)),
			});
			resources.add(addDisposableListener(window, 'resize', layout));
			return await new Promise<Icon | null | undefined>(resolve => {
				let selected: Icon | null | undefined;
				resources.add(widget.onDidHide(() => resolve(selected)));
				resources.add(toDisposable(() => resolve(undefined)));
				resources.add(grid.onDidSelect(icon => {
					selected = icon;
					widget.hide();
				}));
				resources.add(addDisposableListener(reset, 'click', () => {
					selected = null;
					widget.hide();
				}));
				layout();
				widget.show();
				grid.focus();
			});
		} finally {
			this._store.delete(resources);
		}
	}
}
