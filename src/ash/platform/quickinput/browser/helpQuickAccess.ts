import { DisposableStore } from '../../../base/common/lifecycle.js';
import { QuickAccessRegistry, type IQuickAccessProvider } from '../common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../common/quickInput.js';

interface HelpQuickPickItem extends IQuickPickItem {
	readonly prefix: string;
}
export class HelpQuickAccessProvider implements IQuickAccessProvider {
	provide(picker: IQuickPick<IQuickPickItem>, prefix: string): DisposableStore {
		const disposables = new DisposableStore();
		picker.items = QuickAccessRegistry.all()
			.filter(descriptor => descriptor.prefix !== '' && descriptor.prefix !== prefix)
			.map(descriptor => ({
				prefix: descriptor.prefix,
				label: `${descriptor.prefix} ${descriptor.helpLabel}`,
				description: descriptor.placeholder,
			}));
		disposables.add(picker.onDidAccept(item => {
			picker.value = (item as HelpQuickPickItem).prefix;
			picker.valueSelection = { start: picker.value.length, end: picker.value.length };
		}));
		return disposables;
	}
}
