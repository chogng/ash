import './iconPicker.css';
import { addDisposableListener, getActiveDocument, getWindow, h } from '../../../../base/browser/dom.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getAllLxicons } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { WorkbenchIconSelectBox } from './iconSelectBox.js';

export class IconPicker extends Disposable {
	constructor(@IQuickInputService private readonly quickInput: IQuickInputService) {
		super();
	}

	/** Returns null on reset and undefined on dismissal. */
	async pickIcons(title = localize('iconPicker.changeIcon', 'Change icon'), anchor?: HTMLElement): Promise<Icon | null | undefined> {
		const resources = this._register(new DisposableStore());
		try {
			const document = anchor?.ownerDocument ?? getActiveDocument();
			const window = getWindow(document);
			const content = h(document, 'div', { className: 'ash-icon-picker', attributes: { role: 'dialog', 'aria-label': title } });
			const heading = h(document, 'h2', { className: 'ash-icon-picker-title' }, title);
			content.append(heading);
			// Let the widget restore focus before the grid removes the focused input.
			const widget = resources.add(this.quickInput.createQuickWidget());
			const grid = resources.add(new WorkbenchIconSelectBox({
				icons: getAllLxicons(),
				inputBoxStyles: defaultInputBoxStyles,
				showIconInfo: true,
				showResetButton: true,
			}, content));
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
				resources.add(grid.onDidReset(() => {
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
