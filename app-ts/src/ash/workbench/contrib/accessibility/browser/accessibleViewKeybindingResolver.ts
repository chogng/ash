import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { localize } from '../../../../nls.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

export function resolveContentAndKeybindingItems(keybindingService: IKeybindingService, value?: string): {
	content: MarkdownString;
	configureKeybindingItems: (IQuickPickItem & { id: string })[] | undefined;
	configuredKeybindingItems: (IQuickPickItem & { id: string })[] | undefined;
} | undefined {
	if (!value) {
		return undefined;
	}
	const assigned = new Map<string, IQuickPickItem & { id: string }>();
	const unassigned = new Map<string, IQuickPickItem & { id: string }>();
	const text = value.replace(/<keybinding:([^<>\s]+)>/gu, (_marker, commandId: string) => {
		const binding = keybindingService.lookupKeybinding(commandId);
		const item = { id: commandId, label: commandId };
		if (binding) {
			assigned.set(commandId, item);
			return getKeybindingLabel(binding, KeybindingLabelStyle.Aria);
		}
		unassigned.set(commandId, item);
		return localize('accessibility.unassignedKeybinding', 'No keyboard shortcut assigned for {0}', commandId);
	});
	return {
		content: new MarkdownString(text),
		configureKeybindingItems: unassigned.size ? [...unassigned.values()] : undefined,
		configuredKeybindingItems: assigned.size ? [...assigned.values()] : undefined,
	};
}
