import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { QuickAccessRegistry, type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

interface HelpQuickPickItem extends IQuickPickItem {
	readonly prefix: string;
}

class HelpQuickAccessProvider implements IQuickAccessProvider {
	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const disposables = new DisposableStore();
		picker.items = QuickAccessRegistry.all()
			.filter(descriptor => descriptor.prefix !== '')
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

QuickAccessRegistry.register({ prefix: '?', placeholder: 'Select a search mode', helpLabel: 'Show Search Modes', ctor: HelpQuickAccessProvider });
