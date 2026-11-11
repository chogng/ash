import { localize } from '../../../../../../../nls.js';
import { Action, SubmenuAction } from '../../../../../../../base/common/actions.js';
import type { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { Menu, type IMenuOptions } from '../../../../../../../base/browser/ui/menu/menu.js';
import { defaultButtonStyles, defaultKeybindingLabelStyles, defaultMenuStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

/** The catalog already reflects connection availability; preserve each provider's exact option ID. */
export function modelPickerAccelerationOptions(entry: ModelCatalogEntry): readonly {
	value: string | null;
	label: string;
	description?: string;
	checked: boolean;
}[] {
	if (!entry.accelerationOptions?.length) { return []; }
	return [
		{ value: null, label: localize('chat.modelPicker.defaultAcceleration', 'Default'), checked: entry.selectedAcceleration === null || entry.selectedAcceleration === undefined },
		...entry.accelerationOptions.map(option => ({
			value: option.id,
			label: accelerationLabel(option.name),
			description: accelerationDescription(option.description),
			checked: option.id === entry.selectedAcceleration,
		})),
	];
}

function accelerationLabel(name: string): string {
	switch (name) {
		case 'Fast': return localize('chat.modelPicker.fast', 'Fast');
		case 'Ultra Fast': return localize('chat.modelPicker.ultraFast', 'Ultra Fast');
		case 'Priority': return localize('chat.modelPicker.priority', 'Priority');
		default: return name;
	}
}

function accelerationDescription(description: string): string {
	switch (description) {
		case 'Faster responses, increased usage': return localize('chat.modelPicker.fastDescription', 'Faster responses, increased usage');
		case 'Priority processing, increased usage': return localize('chat.modelPicker.priorityDescription', 'Priority processing, increased usage');
		case 'Uses committed Priority Tier capacity when available': return localize('chat.modelPicker.committedPriorityDescription', 'Uses committed Priority Tier capacity when available');
		default: return description;
	}
}

/** The compact switch is sufficient when Fast is the only alternative. */
export function getFastModelVariant(entry: ModelCatalogEntry) {
	const options = entry.accelerationOptions;
	return options?.length === 1 && options[0].name === 'Fast' ? options[0] : undefined;
}

/** The host picker retains its own menu and preference-write lifetime. */
export function renderModelSpeedMenu(
	container: HTMLElement,
	options: ReturnType<typeof modelPickerAccelerationOptions>,
	resources: DisposableStore,
	choose: (value: string | null) => Promise<unknown>,
	submenuContextView?: IMenuOptions['submenuContextView'],
): readonly Action[] {
	const actions = options.map((option, index) => resources.add(new Action(
		`chat.modelPicker.speed.${index}`, option.label, undefined, true, () => choose(option.value),
	)));
	resources.add(new Menu(container, [new SubmenuAction(
		'chat.modelPicker.speed', localize('chat.modelPicker.speed', 'Speed'), actions, Lxicon.lightning,
	)], {
		buttonStyles: defaultButtonStyles,
		keybindingLabelStyles: defaultKeybindingLabelStyles,
		iconPlacement: 'leading-with-trailing-check',
		getCheckedActionsRepresentation: () => 'radio',
		submenuVerticalAlignment: 'bottom',
		tabLeavesSubmenu: true,
		submenuContextView,
	}, defaultMenuStyles));
	return actions;
}
