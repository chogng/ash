import "./media/editorGroupWatermark.css";
import { KeybindingLabel } from "../../../../base/browser/ui/keybindinglabel/keybindinglabel.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, type IDisposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import type { CommandId } from "../../../../platform/commands/common/commands.js";
import { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { h } from "../../../../base/browser/dom.js";
import { localize } from "../../../../nls.js";
import { ShowAllCommandsCommandId } from "../../quickaccess.js";

/** One command presented while an editor group has no active editor. */
export interface IEditorGroupWatermarkEntry {
	readonly id: string;
	readonly label: string;
	readonly command: CommandId;
}

class EditorGroupWatermarkRegistry {
	private readonly entries = new Map<string, IEditorGroupWatermarkEntry>();
	private readonly _onDidChange = new Emitter<void>();

	readonly onDidChange: Event<void> = this._onDidChange.event;

	register(entry: IEditorGroupWatermarkEntry): IDisposable {
		if (this.entries.has(entry.id)) {
			throw new TypeError(
				`Editor group watermark entry '${entry.id}' is already registered`,
			);
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
export const EditorGroupWatermarkEntries =
	new EditorGroupWatermarkRegistry();

EditorGroupWatermarkEntries.register({
	id: ShowAllCommandsCommandId,
	get label() { return localize('quickAccess.showAllCommands', 'Show All Commands'); },
	command: ShowAllCommandsCommandId,
});

/** Renders command shortcuts when an editor group has no active editor. */
export class EditorGroupWatermark extends Disposable {
	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';
	readonly domNode: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, "div");
		this.domNode.className = "ash-editor-group-watermark-shortcuts";
		this.domNode.setAttribute("aria-label", localize('workbench.editor.shortcuts', 'Editor shortcuts'));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(EditorGroupWatermarkEntries.onDidChange(() => this.render()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY)) {
				this.render();
			}
		}));
		this._register(
			this.keybindingService.onDidUpdateKeybindings(() => this.render()),
		);
		this.render();
	}

	private render(): void {
		this.rendered.clear();
		if (!this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY)) {
			this.domNode.replaceChildren();
			return;
		}
		const ownerDocument = this.domNode.ownerDocument;
		const rows = EditorGroupWatermarkEntries.getEntries()
			.flatMap((entry) => {
				const keybinding =
					this.keybindingService.lookupKeybinding(entry.command);
				if (!keybinding) return [];

				const row = h(ownerDocument, "div");
				row.className = "ash-editor-group-watermark-entry";
				const label = h(ownerDocument, "span");
				label.className = "ash-editor-group-watermark-label";
				label.textContent = entry.label;
				const shortcut = this.rendered.add(new KeybindingLabel(row, {
					keybinding,
					presentation: "keycap",
				}));
				row.append(label, shortcut.element);
				return [row];
			});
		this.domNode.replaceChildren(...rows);
	}
}
