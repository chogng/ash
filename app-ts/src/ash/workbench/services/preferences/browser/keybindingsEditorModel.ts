import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { serializeKeybinding } from '../../../../base/common/keybindingParser.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, type CommandId, type CommandRegistry } from '../../../../platform/commands/common/commands.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingRuleKind, KeybindingsRegistry, KeybindingSource, type KeybindingRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IKeybindingEntry, IKeybindingsResourceService } from '../../../../platform/keybinding/common/keybindingsResource.js';

export type KeyboardShortcutItemSource = 'builtin' | 'unassigned' | 'user' | 'workbench';

export interface KeyboardShortcutItem {
	readonly id: string;
	readonly command: CommandId | null;
	readonly commandLabel: string;
	readonly key: string;
	readonly keyLabel: string;
	readonly when: string;
	readonly source: KeyboardShortcutItemSource;
	readonly sourceLabel: string;
}

export interface KeyboardShortcutsEditorModelOptions {
	readonly keybindingService: IKeybindingService;
	readonly resourceService: IKeybindingsResourceService;
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

	constructor(private readonly options: KeyboardShortcutsEditorModelOptions) {
		super();
		this.commandRegistry = options.commandRegistry ?? CommandsRegistry;
		this.keybindingRegistry = options.keybindingRegistry ?? KeybindingsRegistry;
		this.refresh();
		this._register(options.resourceService.onDidChangeKeybindings(() => this.refresh()));
		this._register(this.keybindingRegistry.onDidChangeKeybindings(() => this.refresh()));
		this._register(options.keybindingService.onDidUpdateKeybindings(() => this.refresh()));
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
		const normalizedWhen = when.trim();
		if (!this.options.keybindingService.resolveUserBinding(normalizedKey)) {
			throw new TypeError(`Invalid keybinding: ${normalizedKey || '(empty)'}`);
		}
		const bindings = [...this.options.resourceService.getKeybindings()];
		const entry: IKeybindingEntry = {
			key: normalizedKey,
			command: item.command,
			...(normalizedWhen ? { when: normalizedWhen } : {}),
		};
		if (item.source === 'user') {
			const index = findUserEntryIndex(bindings, item.id);
			if (index < 0) throw new Error('This shortcut changed before it could be saved.');
			bindings[index] = {
				...bindings[index],
				...entry,
			};
		} else {
			bindings.push(entry);
		}
		await this.options.resourceService.updateKeybindings(bindings);
	}

	public async remove(item: KeyboardShortcutItem): Promise<void> {
		if (item.source !== 'user') throw new TypeError('Only user shortcuts can be removed.');
		const bindings = [...this.options.resourceService.getKeybindings()];
		const index = findUserEntryIndex(bindings, item.id);
		if (index < 0) throw new Error('This shortcut was already removed.');
		bindings.splice(index, 1);
		await this.options.resourceService.updateKeybindings(bindings);
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
				command,
				commandLabel: command ? this.options.commandLabel(command) : 'Blocked shortcut',
				key: serializeKeybinding(rule.keybinding),
				keyLabel: getKeybindingLabel(this.options.keybindingService.resolveKeybinding(rule.keybinding)),
				when: rule.when ? [...rule.when.keys()].sort().join(' && ') : '',
				source,
				sourceLabel: source === 'builtin' ? 'Default' : 'Workbench',
			});
		}

		const userOccurrences = new Map<string, number>();
		for (const entry of this.options.resourceService.getKeybindings()) {
			if (entry.command) assignedCommands.add(entry.command);
			const fingerprint = userEntryFingerprint(entry);
			const occurrence = userOccurrences.get(fingerprint) ?? 0;
			userOccurrences.set(fingerprint, occurrence + 1);
			const resolved = this.options.keybindingService.resolveUserBinding(entry.key);
			items.push({
				id: userItemId(entry, occurrence),
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

function findUserEntryIndex(bindings: readonly IKeybindingEntry[], itemId: string): number {
	const occurrences = new Map<string, number>();
	for (let index = 0; index < bindings.length; index += 1) {
		const entry = bindings[index];
		const fingerprint = userEntryFingerprint(entry);
		const occurrence = occurrences.get(fingerprint) ?? 0;
		occurrences.set(fingerprint, occurrence + 1);
		if (userItemId(entry, occurrence) === itemId) return index;
	}
	return -1;
}

function userItemId(entry: IKeybindingEntry, occurrence: number): string {
	return `user:${stableHash(userEntryFingerprint(entry))}:${occurrence}`;
}

function userEntryFingerprint(entry: IKeybindingEntry): string {
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
