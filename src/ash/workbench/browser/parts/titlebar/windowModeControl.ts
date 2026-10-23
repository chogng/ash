import './windowModeControl.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
		const group = h(container.ownerDocument, 'div');
		group.className = 'ash-window-mode-control ash-titlebar-interactive-region';
		group.setAttribute('role', 'toolbar');
		group.setAttribute('aria-label', localize({ bundle: 'ash', key: 'windowMode.label' }, 'Workspace mode'));
		const modes = [
			{ id: 'agents', label: localize({ bundle: 'ash', key: 'windowMode.agents' }, 'Chat / Agents'), icon: Lxicon.chat1 },
			{ id: 'code', label: localize({ bundle: 'ash', key: 'windowMode.code' }, 'Code'), icon: Lxicon.code },
		] as const;
		const buttons = modes.map(mode => {
			const button = h(container.ownerDocument, 'button');
			button.type = 'button';
			button.className = 'ash-window-mode-button';
			button.setAttribute('aria-label', mode.label);
			appendIcon(mode.icon, button);
			this._register(hovers.setupDelayedHover(button, { content: mode.label }));
			this._register(addDisposableListener(button, 'click', () => {
				// Selecting the current workspace also returns from one of its child pages.
				void commands.executeCommand(switchCommands[mode.id]).catch(onUnexpectedError);
			}));
			group.append(button);
			return button;
		});
		this._register(autorun(reader => {
			const selected = active.read(reader);
			buttons.forEach((button, i) => {
				const checked = modes[i]!.id === selected;
				button.setAttribute('aria-pressed', String(checked));
				button.tabIndex = checked ? 0 : -1;
			});
		}));
		this._register(addDisposableListener(group, 'keydown', event => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			const index = buttons.indexOf(event.target as HTMLButtonElement);
			if (index < 0) return;
			let next: number;
			switch (event.key) {
				case 'ArrowLeft': case 'ArrowRight': next = 1 - index; break;
				case 'Home': next = 0; break;
				case 'End': next = 1; break;
				default: return;
			}
			event.preventDefault();
			event.stopPropagation();
			buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
			buttons[next]!.focus();
		}));
		container.append(group);
		this._register(toDisposable(() => group.remove()));
	}
}
