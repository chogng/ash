import { type ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { localize } from '../../../../nls.js';
import { type LanguageCodeAction } from '../../../common/languages.js';
import { type CodeActionItem } from '../common/types.js';

export function toMenuItems(
	inputCodeActions: readonly CodeActionItem[], showHeaders: boolean,
	keybindingResolver: (action: LanguageCodeAction) => ResolvedKeybinding | undefined,
): IActionListItem<CodeActionItem>[] {
	const groups = new Map<string, IActionListItem<CodeActionItem>[]>();
	for (const entry of inputCodeActions) {
		const title = groupTitle(entry.action.kind);
		let items = groups.get(title);
		if (!items) { items = []; groups.set(title, items); }
		items.push({
			kind: ActionListItemKind.Action, item: entry, group: { title },
			label: entry.action.disabledReason
				? localize('codeAction.disabled', '{0} ({1})', entry.action.title, entry.action.disabledReason)
				: entry.action.title,
			disabled: entry.action.disabledReason !== undefined,
			canPreview: entry.action.edit !== undefined || entry.provider.resolveCodeAction !== undefined,
			keybinding: keybindingResolver(entry.action),
		});
	}
	const items: IActionListItem<CodeActionItem>[] = [];
	for (const [title, actions] of groups) {
		if (showHeaders && groups.size > 1) { items.push({ kind: ActionListItemKind.Header, label: title }); }
		items.push(...actions);
	}
	return items;
}

function groupTitle(kind: string | undefined): string {
	switch (kind?.split('.')[0]) {
		case 'quickfix': return localize('codeAction.group.quickfix', 'Quick Fix');
		case 'refactor': return localize('codeAction.group.refactor', 'Refactor');
		case 'source': return localize('codeAction.group.source', 'Source Action');
		default: return localize('codeAction.group.other', 'Other Actions');
	}
}
