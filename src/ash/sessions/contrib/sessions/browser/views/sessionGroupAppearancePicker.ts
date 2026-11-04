import { Lxicon } from '../../../../../base/common/lxicons.js';
import { themeColorFromId, ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { chartsBlue, chartsGreen, chartsOrange, chartsPurple } from '../../../../../platform/theme/common/colors/chartsColors.js';
import { getIconRegistry } from '../../../../../platform/theme/common/iconRegistry.js';
import {
	terminalAnsiBlack, terminalAnsiBlue, terminalAnsiCyan, terminalAnsiGreen, terminalAnsiMagenta,
	terminalAnsiRed, terminalAnsiWhite, terminalAnsiYellow,
} from '../../../../../workbench/contrib/terminal/common/terminalColorRegistry.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { pickSessionDestination } from '../sessionsPicker.js';

export const CHANGE_SESSION_GROUP_APPEARANCE = 'sessions.list.changeGroupAppearance';

registerAction2(class ChangeSessionGroupAppearanceAction extends Action2 {
	constructor() {
		super({ id: CHANGE_SESSION_GROUP_APPEARANCE, title: localize2('sessions.list.changeGroupAppearance', 'Change group appearance') });
	}

	override async run(accessor: ServicesAccessor, sectionId?: unknown, property?: unknown): Promise<void> {
		if (typeof sectionId !== 'string' || property !== 'icon' && property !== 'color') return;
		const groups = accessor.get(ISessionGroupsService);
		const group = groups.groups.find(group => group.sectionId === sectionId && group.kind !== 'comparison');
		if (!group) return;
		const picker = accessor.get(IInstantiationService).createInstance(SessionGroupAppearancePicker);
		const apply = (value: string | undefined) => groups.setGroupAppearance(sectionId, property, value);
		if (property === 'icon') {
			await picker.changeIcon(apply, group.icon);
		} else {
			await picker.changeColor(group.color, apply);
		}
	}
});

class SessionGroupAppearancePicker {
	constructor(@IQuickInputService private readonly input: IQuickInputService) { }

	async changeIcon(setIcon: (id: string | undefined) => Promise<void>, currentIcon?: string): Promise<void> {
		const labels = new Map([
			[Lxicon.folder.id, localize('sessions.list.groupIconFolder', 'Folder')],
			[Lxicon.chat.id, localize('sessions.list.groupIconChat', 'Chat')],
			[Lxicon.clockface.id, localize('sessions.list.groupIconClock', 'Clock')],
		]);
		const icons = getIconRegistry().getIcons().map(({ id }) => ({
			id,
			label: labels.get(id) ?? id,
			description: labels.has(id) ? id : undefined,
			iconClass: ThemeIcon.asClassName({ id }),
		}));
		const selected = await pickSessionDestination(this.input, localize('sessions.list.changeGroupIcon', 'Change group icon'), [
			{ id: '', label: localize('sessions.list.groupAppearanceDefault', 'Default') },
			...icons,
		], currentIcon ?? '');
		if (selected) await setIcon(selected.id || undefined);
	}

	async changeColor(currentColor: string | undefined, setColor: (id: string | undefined) => Promise<void>): Promise<void> {
		const blue = localize('sessions.list.groupColorBlue', 'Blue');
		const green = localize('sessions.list.groupColorGreen', 'Green');
		const palette = [
			[terminalAnsiBlack, localize('sessions.list.groupColorBlack', 'Black')],
			[terminalAnsiRed, localize('sessions.list.groupColorRed', 'Red')],
			[terminalAnsiGreen, green],
			[terminalAnsiYellow, localize('sessions.list.groupColorYellow', 'Yellow')],
			[terminalAnsiBlue, blue],
			[terminalAnsiMagenta, localize('sessions.list.groupColorMagenta', 'Magenta')],
			[terminalAnsiCyan, localize('sessions.list.groupColorCyan', 'Cyan')],
			[terminalAnsiWhite, localize('sessions.list.groupColorWhite', 'White')],
		];
		const savedColors = new Map([
			[chartsBlue, blue], [chartsGreen, green],
			[chartsOrange, localize('sessions.list.groupColorOrange', 'Orange')],
			[chartsPurple, localize('sessions.list.groupColorPurple', 'Purple')],
		]);
		// Keep the exact theme token selected for groups saved with the earlier palette.
		const savedLabel = currentColor && savedColors.get(currentColor);
		if (currentColor && savedLabel) palette.push([currentColor, savedLabel]);
		const selected = await pickSessionDestination(this.input, localize('sessions.list.changeGroupColor', 'Change group color'), [
			{ id: '', label: localize('sessions.list.groupAppearanceDefault', 'Default') },
			...palette.map(([id, label]) => ({
				id, label, description: id,
				iconClass: ThemeIcon.asClassName(Lxicon.circleFilled),
				iconColor: themeColorFromId(id),
			})),
		], currentColor ?? '');
		if (selected) await setColor(selected.id || undefined);
	}
}
