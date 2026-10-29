import { matchesSubString } from '../../../../../base/common/filters.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { PickerQuickAccessProvider, TriggerAction, type IPickerQuickAccessItem } from '../../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalEditingService, ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';

/** Projects the window's existing instances; accepting never creates or moves a shell. */
export class TerminalQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	static readonly PREFIX = 'term ';
	private readonly picks = new Map<ITerminalInstance, IPickerQuickAccessItem>();

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalGroupService private readonly groups: ITerminalGroupService,
		@ITerminalEditorService private readonly editors: ITerminalEditorService,
		@ITerminalEditingService private readonly editing: ITerminalEditingService,
	) {
		super(TerminalQuickAccessProvider.PREFIX, {
			noResultsPick: () => ({ label: localize('terminal.quickAccess.empty', 'No matching terminals') }),
		});
		this._register(terminals.onDidChangeInstances(() => this.refresh()));
		this._register(terminals.onDidChangeActiveInstance(() => this.refresh()));
	}

	protected override _getPicks(filter: string): IPickerQuickAccessItem[] {
		const instances = new Set(this.terminals.instances);
		for (const instance of this.picks.keys()) {
			if (!instances.has(instance)) this.picks.delete(instance);
		}
		return [...instances]
			.filter(instance => matchesSubString(filter, instance.title))
			.map(instance => {
				let pick = this.picks.get(instance);
				if (!pick) {
					pick = this.createPick(instance);
					this.picks.set(instance, pick);
				}
				return pick;
			});
	}

	private createPick(instance: ITerminalInstance): IPickerQuickAccessItem {
		const terminals = this.terminals;
		// The picker retains its browsed row by object identity when a preceding
		// terminal disappears. Getters keep presentation current without copying state.
		return {
			get label() {
				return instance.title;
			},
			get description() {
				return instance.target === TerminalLocation.Editor ? localize('terminal.quickAccess.editor', 'Editor') : localize('terminal.quickAccess.panel', 'Panel');
			},
			get picked() {
				return instance === terminals.activeInstance;
			},
			buttons: [
				{
					id: 'rename',
					label: localize('terminal.quickAccess.rename', 'Rename Terminal'),
					iconClass: 'lxicon lxicon-edit',
				},
				{
					id: 'close',
					label: localize('terminal.quickAccess.close', 'Close Terminal'),
					iconClass: 'lxicon lxicon-trash',
				},
			],
			accept: () => {
				void this.reveal(instance).catch(onUnexpectedError);
			},
			trigger: async index => {
				// A displayed pick can outlive disposal or close confirmation. Identity is
				// the instance object, never its reusable title, process ID or list index.
				if (!this.terminals.instances.includes(instance)) return TriggerAction.REFRESH_PICKER;
				if (index === 0) {
					await this.editing.rename(instance);
				} else if (index === 1) {
					await this.terminals.safeDisposeTerminal(instance);
				}
				return TriggerAction.REFRESH_PICKER;
			},
		};
	}

	protected override disposeCore(): void {
		this.picks.clear();
		super.disposeCore();
	}

	private async reveal(instance: ITerminalInstance): Promise<void> {
		if (!this.terminals.instances.includes(instance)) return;
		this.terminals.setActiveInstance(instance);
		if (instance.target === TerminalLocation.Editor) await this.editors.openEditor(instance);
		else await this.groups.showPanel(true);
	}
}
