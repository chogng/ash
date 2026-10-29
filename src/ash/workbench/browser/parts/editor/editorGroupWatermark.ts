import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/editorGroupWatermark.css';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { getKeybindingLabel, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService, type CommandId } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { localize } from '../../../../nls.js';
import { ShowAllCommandsCommandId } from '../../quickaccess.js';

/** One command presented while an editor group has no active editor. */
export interface IEditorGroupWatermarkEntry {
	readonly id: string;
	readonly label: string;
	readonly command: CommandId;
	readonly icon?: Icon;
}

class EditorGroupWatermarkRegistry {
	private readonly entries = new Map<string, IEditorGroupWatermarkEntry>();
	private readonly _onDidChange = new Emitter<void>();

	readonly onDidChange: Event<void> = this._onDidChange.event;

	register(entry: IEditorGroupWatermarkEntry): IDisposable {
		if (this.entries.has(entry.id)) {
			throw new TypeError(`Editor group watermark entry '${entry.id}' is already registered`);
		}
		this.entries.set(entry.id, entry);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this.entries.delete(entry.id)) {
				this._onDidChange.fire();
			}
		});
	}

	getEntries(): readonly IEditorGroupWatermarkEntry[] {
		return [...this.entries.values()];
	}
}

/** Registry populated by command contributions shown in the empty editor. */
export const EditorGroupWatermarkEntries = new EditorGroupWatermarkRegistry();

EditorGroupWatermarkEntries.register({
	id: 'workbench.action.quickOpen',
	get label() {
		return localize('workbench.editor.goToFile', 'Go to File');
	},
	command: 'workbench.action.quickOpen',
	icon: Lxicon.goToFile,
});
EditorGroupWatermarkEntries.register({
	id: 'workbench.action.findInFiles',
	get label() {
		return localize('search.focus', 'Search in Files');
	},
	command: 'workbench.action.findInFiles',
	icon: Lxicon.search,
});
EditorGroupWatermarkEntries.register({
	id: ShowAllCommandsCommandId,
	get label() {
		return localize('quickAccess.showAllCommands', 'Show All Commands');
	},
	command: ShowAllCommandsCommandId,
	icon: Lxicon.command,
});

/** Renders command shortcuts when an editor group has no active editor. */
export class EditorGroupWatermark extends Disposable {
	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';
	readonly domNode: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());
	private readonly shortcuts: {
		readonly command: CommandId;
		readonly row: HTMLButtonElement;
		readonly label: MutableDisposable<KeybindingLabel>;
	}[] = [];

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'ash-editor-group-watermark-shortcuts';
		this.domNode.setAttribute('aria-label', localize('workbench.editor.shortcuts', 'Editor shortcuts'));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(EditorGroupWatermarkEntries.onDidChange(() => this.render()));
		this._register(
			this.configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY)) {
					this.render();
				}
			}),
		);
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.updateKeybindings()));
		this.render();
	}

	layout(height: number): void {
		// Preserve the actions when a terminal or another group leaves little vertical space.
		this.domNode.classList.toggle('compact', height < 200);
	}

	private render(): void {
		this.rendered.clear();
		this.shortcuts.length = 0;
		if (!this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY)) {
			this.domNode.replaceChildren();
			return;
		}
		const ownerDocument = this.domNode.ownerDocument;
		const heading = h(ownerDocument, 'h2');
		heading.className = 'ash-editor-group-watermark-heading';
		heading.textContent = localize('workbench.editor.startWorking', 'Start Working');
		const entries = h(ownerDocument, 'div');
		entries.className = 'ash-editor-group-watermark-entries';
		const rows = EditorGroupWatermarkEntries.getEntries().map(entry => {
			const row = h(ownerDocument, 'button');
			row.type = 'button';
			row.className = 'ash-editor-group-watermark-entry';
			// Keep the action name concise and announce its shortcut through the description.
			row.setAttribute('aria-label', entry.label);
			const name = h(ownerDocument, 'span');
			name.className = 'ash-editor-group-watermark-name';
			if (entry.icon) {
				appendIcon(entry.icon, name);
			}
			const label = h(ownerDocument, 'span');
			label.className = 'ash-editor-group-watermark-label';
			label.textContent = entry.label;
			name.append(label);
			row.append(name);
			this.shortcuts.push({
				command: entry.command,
				row,
				label: this.rendered.add(new MutableDisposable<KeybindingLabel>()),
			});
			this.rendered.add(
				addDisposableListener(row, 'click', () => {
					void this.commandService.executeCommand(entry.command).catch(onUnexpectedError);
				}),
			);
			return row;
		});
		entries.append(...rows);
		this.domNode.replaceChildren(...(rows.length ? [heading, entries] : []));
		this.updateKeybindings();
	}

	private updateKeybindings(): void {
		// Keep the button nodes stable while users edit bindings, including removing a binding.
		for (const shortcut of this.shortcuts) {
			const keybinding = this.keybindingService.lookupKeybinding(shortcut.command);
			if (!keybinding) {
				shortcut.label.clear();
				shortcut.row.removeAttribute('aria-description');
			} else if (shortcut.label.value) {
				shortcut.label.value.keybinding = keybinding;
			} else {
				shortcut.label.value = new KeybindingLabel(shortcut.row, {
					...defaultKeybindingLabelStyles,
					keybinding,
					presentation: 'keycap',
				});
			}
			if (keybinding) {
				shortcut.row.setAttribute('aria-description', getKeybindingLabel(keybinding, KeybindingLabelStyle.Aria));
			}
		}
	}
}
