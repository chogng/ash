import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { getIconRegistry } from '../../../../platform/theme/common/iconRegistry.js';

interface IconPick extends IQuickPickItem { readonly icon: ThemeIcon; }

/** Uses the same registered icons as tabs; no parallel icon catalog or renderer. */
export class TerminalIconPicker extends Disposable {
	private readonly selection = this._register(new MutableDisposable<DisposableStore>());
	constructor(@IQuickInputService private readonly quickInput: IQuickInputService) { super(); }

	pickIcons(): Promise<ThemeIcon | undefined> {
		if (this.isDisposed) return Promise.resolve(undefined);
		const lifetime = new DisposableStore();
		this.selection.value = lifetime;
		const picker = lifetime.add(this.quickInput.createQuickPick<IconPick>());
		picker.ariaLabel = localize('terminal.icon.title', 'Change Terminal Icon');
		picker.placeholder = localize('terminal.icon.placeholder', 'Select an icon for the terminal');
		picker.items = getIconRegistry().getIcons().map(icon => ({ label: icon.id, icon: { id: icon.id } }));
		return new Promise(resolve => {
			let selected: ThemeIcon | undefined;
			lifetime.add(toDisposable(() => resolve(undefined)));
			lifetime.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;

				if (!getIconRegistry().getIcon(item.icon.id)) return;
				selected = item.icon;
				picker.hide();

			}));
			lifetime.add(picker.onDidHide(() => { resolve(selected); this.selection.clear(); }));
			picker.show();
		});
	}
}
