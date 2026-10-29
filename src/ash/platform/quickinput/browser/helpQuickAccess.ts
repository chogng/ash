import { QuickAccessRegistry } from '../common/quickAccess.js';
import { IQuickInputService } from '../common/quickInput.js';
import { PickerQuickAccessProvider, type IPickerQuickAccessItem, type Picks } from './pickerQuickAccess.js';
import { filterQuickPickItems } from './quickInputList.js';

export class HelpQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	constructor(@IQuickInputService private readonly quickInput: IQuickInputService) {
		super('?');
	}

	protected override _getPicks(filter: string): Picks<IPickerQuickAccessItem> {
		return filterQuickPickItems(
			QuickAccessRegistry.all()
				.filter(descriptor => descriptor.prefix !== '' && descriptor.prefix !== '?')
				.map(descriptor => ({
					label: `${descriptor.prefix} ${descriptor.helpLabel}`,
					description: descriptor.placeholder,
					keepOpen: true,
					accept: () => this.quickInput.quickAccess.show(descriptor.prefix),
				})),
			filter,
		);
	}
}
