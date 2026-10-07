import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { serializeKeybinding } from '../../../../base/common/keybindingParser.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, type CommandId, type CommandRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingRuleKind, KeybindingsRegistry, KeybindingSource, type KeybindingRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IKeybindingEditingService } from '../../keybinding/common/keybindingEditing.js';
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

export interface KeyboardShortcutsEditorModelOptions {
	readonly commandLabel: (command: CommandId) => string;
	readonly commandRegistry?: CommandRegistry;
	readonly keybindingRegistry?: KeybindingRegistry;
}

/** Builds stable, searchable rows and owns mutations of the user keybindings resource. */
export class KeyboardShortcutsEditorModel extends Disposable {
	private readonly commandRegistry: CommandRegistry;
	private readonly keybindingRegistry: KeybindingRegistry;
	private readonly _onDidChange = this._register(new Emitter<readonly KeyboardShortcutItem[]>());
	private query = '';
	private allItems: readonly KeyboardShortcutItem[] = [];

	public readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly options: KeyboardShortcutsEditorModelOptions,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IKeybindingEditingService private readonly editing: IKeybindingEditingService,
	) {
		super();
		this.commandRegistry = options.commandRegistry ?? CommandsRegistry;
		this.keybindingRegistry = options.keybindingRegistry ?? KeybindingsRegistry;
		this.refresh();
		this._register(this.keybindingRegistry.onDidChangeKeybindings(() => this.refresh()));
		this._register(this.keybindings.onDidUpdateKeybindings(() => this.refresh()));
	}

	public get items(): readonly KeyboardShortcutItem[] {
		return filterItems(this.allItems, this.query);
	}

	public setQuery(query: string): void {
		const normalized = query.trim().toLocaleLowerCase();
		if (normalized === this.query) return;
		this.query = normalized;
		this._onDidChange.fire(this.items);
	}

	public async save(item: KeyboardShortcutItem, key: string, when: string): Promise<void> {
		const normalizedKey = key.trim();
		if (!this.keybindings.resolveUserBinding(normalizedKey)) throw new TypeError(`Invalid keybinding: ${normalizedKey || '(empty)'}`);
		await this.editing.editKeybinding(item.keybindingItem, normalizedKey, when.trim() || undefined);
	}

	public async remove(item: KeyboardShortcutItem): Promise<void> {
		if (item.source !== 'user') throw new TypeError('Only user shortcuts can be removed.');
		await this.editing.removeKeybinding(item.keybindingItem);
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
				commandLabel: command ? this.options.commandLabel(command) : 'Blocked shortcut',
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
				commandLabel: entry.command ? this.options.commandLabel(entry.command) : 'Blocked shortcut',
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
				commandLabel: this.options.commandLabel(command),
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

function compareItems(left: KeyboardShortcutItem, right: KeyboardShortcutItem): number {
	return left.commandLabel.localeCompare(right.commandLabel) || left.keyLabel.localeCompare(right.keyLabel) || left.id.localeCompare(right.id);
}

function filterItems(items: readonly KeyboardShortcutItem[], query: string): readonly KeyboardShortcutItem[] {
	if (!query) return items;
	const terms = query.split(/\s+/).filter(Boolean);
	return items.filter(item => {
		const searchable = `${item.commandLabel} ${item.command ?? ''} ${item.key} ${item.keyLabel} ${item.when} ${item.sourceLabel}`.toLocaleLowerCase();
		return terms.every(term => searchable.includes(term));
	});
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
