import './windowModeControl.css';
import { SegmentedControl } from '../../../../base/browser/ui/segmentedControl/segmentedControl.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';

/** Projects the active workspace page without owning its selection or content. */
export class WindowModeControl extends Disposable {
	constructor(
		container: HTMLElement,
		active: IObservable<'agents' | 'code'>,
		switchCommands: Readonly<Record<'agents' | 'code', string>>,
		@ICommandService commands: ICommandService,
		@IHoverService hovers: IHoverService,
	) {
		super();
		const modes = [
			{
				id: 'agents',
				label: localize({ bundle: 'ash', key: 'windowMode.agents' }, 'Chat / Agents'),
				icon: Lxicon.chat1,
			},
			{ id: 'code', label: localize({ bundle: 'ash', key: 'windowMode.code' }, 'Code'), icon: Lxicon.code },
		] as const;
		const control = this._register(
			new SegmentedControl(container, {
				ariaLabel: localize({ bundle: 'ash', key: 'windowMode.label' }, 'Workspace mode'),
				items: modes,
				selectedId: active.get(),
				presentation: 'icon',
				hoverDelegate: hovers,
				onActivate: mode => {
					// Reactivating the current workspace also returns from one of its child pages.
					void commands.executeCommand(switchCommands[mode]).catch(onUnexpectedError);
				},
			}),
		);
		control.domNode.classList.add('ash-window-mode-control', 'ash-titlebar-interactive-region');
		this._register(autorun(reader => control.setSelection(active.read(reader))));
	}
}
