import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { serializeKeybinding } from '../../../../base/common/keybindingParser.js';
import { commandActionLabel } from '../../../../platform/action/common/action.js';
import { isMenuItem, MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, type CommandId, type CommandRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingRuleKind, KeybindingsRegistry, KeybindingSource, type KeybindingRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorModel } from '../../../common/editor/editorModel.js';
import type { IUserFriendlyKeybinding } from '../../../../platform/keybinding/common/keybinding.js';
import { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { localize } from '../../../../nls.js';

export type KeyboardShortcutItemSource = 'builtin' | 'unassigned' | 'user' | 'workbench' | 'extension';

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

type RankedShortcut = KeyboardShortcutItem & { readonly precedence: readonly [number, number, number]; };

/** Owns searchable rows and service listeners; the editor input owns its lifetime. */
export class KeybindingsEditorModel extends EditorModel {
	private readonly commandRegistry: CommandRegistry = CommandsRegistry;
	private readonly keybindingRegistry: KeybindingRegistry = KeybindingsRegistry;
	private readonly _onDidChange = this._register(new Emitter<readonly KeyboardShortcutItem[]>());
	private allItems: readonly RankedShortcut[] = [];

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

	/** Filtering and presentation order share the model's live rule snapshot. */
	public fetch(searchValue: string, sortByPrecedence = false): readonly KeyboardShortcutItem[] {
		const query = searchValue.trim().toLocaleLowerCase();
		const source = /@source:\s*(system|default|user|extension|unassigned)\b/i.exec(query)?.[1];
		const quoted = /"([^"]*)"/.exec(query);
		const exact = quoted ? this.keybindings.resolveUserBinding(quoted[1]!) : undefined;
		const exactLabel = exact ? getKeybindingLabel(exact, KeybindingLabelStyle.Aria).toLocaleLowerCase() : undefined;
		const terms = query
			.replace(/@source:\s*(system|default|user|extension|unassigned)\b/gi, '')
			.replace(/"[^"]*"/g, '')
			.split(/\s+/)
			.filter(Boolean);
		const items = this.allItems.filter(item => {
			if (source && (source === 'system' || source === 'default'
				? item.source !== 'builtin' && item.source !== 'workbench'
				: item.source !== source)) return false;
			if (quoted) {
				const resolved = item.keybindingItem.resolvedKeybinding;
				if (!resolved || !exactLabel || getKeybindingLabel(resolved, KeybindingLabelStyle.Aria).toLocaleLowerCase() !== exactLabel) return false;
			}
			const searchable = `${item.commandLabel} ${item.command ?? ''} ${item.key} ${item.keyLabel} ${item.when} ${item.sourceLabel}`.toLocaleLowerCase();
			return terms.every(term => term.startsWith('@command:')
				? item.command?.toLocaleLowerCase() === term.slice('@command:'.length)
				: searchable.includes(term));
		});
		return sortByPrecedence ? items.sort((left, right) => {
			for (let index = 0; index < left.precedence.length; index++) {
				const difference = right.precedence[index]! - left.precedence[index]!;
				if (difference) return difference;
			}
			return compareItems(left, right);
		}) : items;
	}

	private refresh(): void {
		const items: RankedShortcut[] = [];
		const assignedCommands = new Set<CommandId>();
		for (const rule of this.keybindingRegistry.getKeybindings()) {
			if (rule.source === KeybindingSource.User) continue;
			const command = rule.kind === KeybindingRuleKind.Command ? rule.command : null;
			if (command) assignedCommands.add(command);
			const source = rule.source === KeybindingSource.Builtin ? 'builtin' : 'workbench';
			items.push({
				precedence: [rule.source ?? KeybindingSource.Workbench, rule.priority ?? 0, rule.order],
				id: `registered:${rule.order}`,
				keybindingItem: new ResolvedKeybindingItem(this.keybindings.resolveKeybinding(rule.keybinding), command, rule.kind === KeybindingRuleKind.Command ? rule.args?.[0] : undefined, rule.when, true, null, true),
				command,
				commandLabel: command ? commandLabel(command) : localize('keybindings.blocked', 'Blocked shortcut'),
				key: serializeKeybinding(rule.keybinding),
				keyLabel: getKeybindingLabel(this.keybindings.resolveKeybinding(rule.keybinding)),
				when: rule.when?.serialize() ?? '',
				source,
				sourceLabel: localize('keybindings.sourceSystem', 'System'),
			});
		}

		const userOccurrences = new Map<string, number>();
		const extensionOccurrences = new Map<string, number>();
		for (const [index, keybindingItem] of this.keybindings.getKeybindings().entries()) {
			// Extension provenance belongs to the resolved service contract, not the command ID.
			if (keybindingItem.isDefault && keybindingItem.extensionId) {
				const command = keybindingItem.command;
				if (command) assignedCommands.add(command);
				const key = keybindingItem.resolvedKeybinding ? getKeybindingLabel(keybindingItem.resolvedKeybinding, KeybindingLabelStyle.UserSettings) : '';
				const fingerprint = JSON.stringify([keybindingItem.extensionId, command, key, keybindingItem.when?.serialize(), keybindingItem.commandArgs]);
				const occurrence = extensionOccurrences.get(fingerprint) ?? 0;
				extensionOccurrences.set(fingerprint, occurrence + 1);
				items.push({
					precedence: [keybindingItem.isBuiltinExtension ? KeybindingSource.Builtin : KeybindingSource.Workbench, 0, index],
					id: `extension:${stableHash(fingerprint)}:${occurrence}`,
					keybindingItem,
					command,
					commandLabel: command ? commandLabel(command) : localize('keybindings.blocked', 'Blocked shortcut'),
					key,
					keyLabel: keybindingItem.resolvedKeybinding ? getKeybindingLabel(keybindingItem.resolvedKeybinding) : '',
					when: keybindingItem.when?.serialize() ?? '',
					source: 'extension',
					sourceLabel: keybindingItem.extensionId,
				});
			}
			if (!keybindingItem.userBinding) continue;
			const entry = keybindingItem.userBinding.entry;
			if (entry.command) assignedCommands.add(entry.command);
			const fingerprint = userEntryFingerprint(entry);
			const occurrence = userOccurrences.get(fingerprint) ?? 0;
			userOccurrences.set(fingerprint, occurrence + 1);
			const resolved = this.keybindings.resolveUserBinding(entry.key);
			items.push({
				precedence: [KeybindingSource.User, 0, keybindingItem.userBinding.index],
				id: userItemId(entry, occurrence),
				keybindingItem,
				command: entry.command,
				commandLabel: entry.command ? commandLabel(entry.command) : localize('keybindings.blocked', 'Blocked shortcut'),
				key: entry.key,
				keyLabel: resolved ? getKeybindingLabel(resolved) : entry.key,
				when: entry.when ?? '',
				source: 'user',
				sourceLabel: localize('keybindings.sourceUser', 'User'),
			});
		}

		for (const command of this.commandRegistry.getCommandIds()) {
			if (assignedCommands.has(command)) continue;
			items.push({
				precedence: [-1, 0, 0],
				id: `unassigned:${command}`,
				keybindingItem: new ResolvedKeybindingItem(undefined, command, undefined, undefined, true, null, false),
				command,
				commandLabel: commandLabel(command),
				key: '',
				keyLabel: '',
				when: '',
				source: 'unassigned',
				sourceLabel: localize('keybindings.sourceUnassigned', 'Unassigned'),
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
