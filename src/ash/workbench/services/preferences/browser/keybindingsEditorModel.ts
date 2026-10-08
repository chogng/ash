import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { serializeKeybinding } from '../../../../base/common/keybindingParser.js';
import { commandActionLabel } from '../../../../platform/action/common/action.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, type CommandId, type CommandRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingRuleKind, KeybindingsRegistry, KeybindingSource, type KeybindingRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorModel } from '../../../common/editor/editorModel.js';
import type { IUserFriendlyKeybinding } from '../../../../platform/keybinding/common/keybinding.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';

export type KeyboardShortcutItemSource = 'builtin' | 'unassigned' | 'user' | 'workbench';

export interface KeyboardShortcutItem {
	readonly id: string;
	readonly keybindingItem: ResolvedKeybindingItem;
	readonly command: CommandId | null;
	readonly commandLabel: string;
	readonly key: string;
	readonly keyLabel: string;
	readonly when: string;
	readonly source: KeyboardShortcutItemSource;
	readonly sourceLabel: string;
}

/** Owns searchable rows and service listeners; the editor input owns its lifetime. */
export class KeybindingsEditorModel extends EditorModel {
	private readonly commandRegistry: CommandRegistry = CommandsRegistry;
	private readonly keybindingRegistry: KeybindingRegistry = KeybindingsRegistry;
	private readonly _onDidChange = this._register(new Emitter<readonly KeyboardShortcutItem[]>());
	private allItems: readonly KeyboardShortcutItem[] = [];

	public readonly onDidChange = this._onDidChange.event;

	constructor(
		@IKeybindingService private readonly keybindings: IKeybindingService,
	) {
		super();
		this.refresh();
		this._register(this.keybindingRegistry.onDidChangeKeybindings(() => this.refresh()));
		this._register(this.keybindings.onDidUpdateKeybindings(() => this.refresh()));
	}

	public get items(): readonly KeyboardShortcutItem[] {
		return this.allItems;
	}

	private refresh(): void {
		const items: KeyboardShortcutItem[] = [];
		const assignedCommands = new Set<CommandId>();
		for (const rule of this.keybindingRegistry.getKeybindings()) {
			if (rule.source === KeybindingSource.User) continue;
			const command = rule.kind === KeybindingRuleKind.Command ? rule.command : null;
			if (command) assignedCommands.add(command);
			const source = rule.source === KeybindingSource.Builtin ? 'builtin' : 'workbench';
			items.push({
				id: `registered:${rule.order}`,
				keybindingItem: new ResolvedKeybindingItem(this.keybindings.resolveKeybinding(rule.keybinding), command, rule.kind === KeybindingRuleKind.Command ? rule.args?.[0] : undefined, rule.when, true, null, true),
				command,
				commandLabel: command ? commandLabel(command) : 'Blocked shortcut',
				key: serializeKeybinding(rule.keybinding),
				keyLabel: getKeybindingLabel(this.keybindings.resolveKeybinding(rule.keybinding)),
				when: rule.when ? [...rule.when.keys()].sort().join(' && ') : '',
				source,
				sourceLabel: source === 'builtin' ? 'Default' : 'Workbench',
			});
		}

		const userOccurrences = new Map<string, number>();
		for (const keybindingItem of this.keybindings.getKeybindings()) {
			if (!keybindingItem.userBinding) continue;
			const entry = keybindingItem.userBinding.entry;
			if (entry.command) assignedCommands.add(entry.command);
			const fingerprint = userEntryFingerprint(entry);
			const occurrence = userOccurrences.get(fingerprint) ?? 0;
			userOccurrences.set(fingerprint, occurrence + 1);
			const resolved = this.keybindings.resolveUserBinding(entry.key);
			items.push({
				id: userItemId(entry, occurrence),
				keybindingItem,
				command: entry.command,
				commandLabel: entry.command ? commandLabel(entry.command) : 'Blocked shortcut',
				key: entry.key,
				keyLabel: resolved ? getKeybindingLabel(resolved) : entry.key,
				when: entry.when ?? '',
				source: 'user',
				sourceLabel: 'User',
			});
		}

		for (const command of this.commandRegistry.getCommandIds()) {
			if (assignedCommands.has(command)) continue;
			items.push({
				id: `unassigned:${command}`,
				keybindingItem: new ResolvedKeybindingItem(undefined, command, undefined, undefined, true, null, false),
				command,
				commandLabel: commandLabel(command),
				key: '',
				keyLabel: '',
				when: '',
				source: 'unassigned',
				sourceLabel: 'Unassigned',
			});
		}

		this.allItems = items.sort(compareItems);
		this._onDidChange.fire(this.items);
	}
}

function commandLabel(command: CommandId): string {
	for (const item of MenusRegistry.getMenuItems(MenuId.CommandPalette)) {
		if (!isMenuItem(item) || item.command.id !== command) continue;
		return commandActionLabel(item.command.title);
	}
	const segment = command.split('.').at(-1) ?? command;
	const words = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
	return words ? words[0].toLocaleUpperCase() + words.slice(1) : command;
}

function compareItems(left: KeyboardShortcutItem, right: KeyboardShortcutItem): number {
	return left.commandLabel.localeCompare(right.commandLabel) || left.keyLabel.localeCompare(right.keyLabel) || left.id.localeCompare(right.id);
}

function userItemId(entry: IUserFriendlyKeybinding, occurrence: number): string {
	return `user:${stableHash(userEntryFingerprint(entry))}:${occurrence}`;
}

function userEntryFingerprint(entry: IUserFriendlyKeybinding): string {
	return JSON.stringify(entry);
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}
