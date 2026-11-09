import { Lxicon } from '../../../../../base/common/lxicons.js';
import { themeColorFromId, ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProjectService } from '../../../../../platform/projects/common/projectService.js';
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
export const CHANGE_PROJECT_APPEARANCE = 'sessions.list.changeProjectAppearance';

registerAction2(class ChangeSessionGroupAppearanceAction extends Action2 {
	constructor() {
		super({ id: CHANGE_SESSION_GROUP_APPEARANCE, title: localize2('sessions.list.changeGroupAppearance', 'Change group appearance') });
	}

	override async run(accessor: ServicesAccessor, sectionId?: unknown, property?: unknown): Promise<void> {
		if (typeof sectionId !== 'string' || property !== 'icon' && property !== 'color') return;
		const groups = accessor.get(ISessionGroupsService);
		const group = groups.groups.find(group => group.sectionId === sectionId && group.kind !== 'comparison');
		if (!group) return;
		const input = accessor.get(IQuickInputService);
		const apply = (value: string | undefined) => groups.setGroupAppearance(sectionId, property, value);
		if (property === 'icon') {
			await pickIcon(input, group.icon, localize('sessions.list.changeGroupIcon', 'Change group icon'), apply);
		} else {
			await pickColor(input, group.color, localize('sessions.list.changeGroupColor', 'Change group color'), apply);
		}
	}
});

registerAction2(class ChangeProjectAppearanceAction extends Action2 {
	constructor() {
		super({ id: CHANGE_PROJECT_APPEARANCE, title: localize2('sessions.list.changeProjectAppearance', 'Change project appearance') });
	}

	override async run(accessor: ServicesAccessor, projectId?: unknown, field?: unknown): Promise<void> {
		if (typeof projectId !== 'string' || !projectId || field !== 'icon' && field !== 'color') return;
		const projects = accessor.get(IProjectService);
		const input = accessor.get(IQuickInputService);
		const project = await projects.read(projectId);
		if (project.archived) return;
		const apply = (value: string | undefined) => value === project[field] ? Promise.resolve() : projects.setAppearance(project, field, value);
		await pickProjectAppearance(input, field, project[field], apply);
	}
});

function pickProjectAppearance(input: IQuickInputService, field: 'icon' | 'color', current: string | undefined,
	apply: (value: string | undefined) => void | Promise<void>): Promise<void> {
	return field === 'icon'
		? pickIcon(input, current, localize('sessions.list.projectIconPicker', 'Change project icon'), apply)
		: pickColor(input, current, localize('sessions.list.projectColorPicker', 'Change project color'), apply);
}

async function pickIcon(input: IQuickInputService, currentIcon: string | undefined, title: string,
	setIcon: (id: string | undefined) => void | Promise<void>): Promise<void> {
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
	const selected = await pickSessionDestination(input, title, [
		{ id: '', label: localize('sessions.list.groupAppearanceDefault', 'Default') },
		...icons,
	], currentIcon ?? '');
	if (selected) await setIcon(selected.id || undefined);
}

export function getAppearanceColors(currentColor?: string): readonly [string, string][] {
	const blue = localize('sessions.list.groupColorBlue', 'Blue');
	const green = localize('sessions.list.groupColorGreen', 'Green');
	const palette: [string, string][] = [
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
	return palette;
}

async function pickColor(input: IQuickInputService, currentColor: string | undefined, title: string,
	setColor: (id: string | undefined) => void | Promise<void>): Promise<void> {
	const selected = await pickSessionDestination(input, title, [
		{ id: '', label: localize('sessions.list.groupAppearanceDefault', 'Default') },
		...getAppearanceColors(currentColor).map(([id, label]) => ({
			id, label, description: id,
			iconClass: ThemeIcon.asClassName(Lxicon.circleFilled),
			iconColor: themeColorFromId(id),
		})),
	], currentColor ?? '');
	if (selected) await setColor(selected.id || undefined);
}
