import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { TaskQueue } from '../../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import {
	registerTerminalContribution,
	type ITerminalContributionContext,
} from '../../../terminal/browser/terminalExtensions.js';
import { TerminalZoomCommandId, TerminalZoomSettingId } from '../common/terminal.zoom.js';

// Commands and wheel events from split panes must read the result of the previous
// write, even when user-settings persistence is asynchronous. Only the configuration
// service retains the font size; these queues own outstanding operations.
const fontUpdates = new WeakMap<IConfigurationService, TaskQueue>();

function updateFontSize(
	configuration: IConfigurationService,
	change: number,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	let queue = fontUpdates.get(configuration);
	if (!queue) {
		queue = new TaskQueue();
		fontUpdates.set(configuration, queue);
	}
	return queue.schedule(async () => {
		if (!isCurrent()) return;
		const setting = 'terminal.integrated.fontSize';
		const size =
			change === 0
				? configuration.inspect<number>(setting).defaultValue
				: configuration.getValue<number>(setting) + change;
		if (size !== undefined) await configuration.updateValue(setting, clampTerminalFontSize(size));
	});
}

/** Matches the terminal font setting's supported range. */
export function clampTerminalFontSize(fontSize: number): number {
	return Math.min(100, Math.max(6, fontSize));
}

class TerminalMouseWheelZoomContribution extends Disposable implements ITerminalContribution {
	constructor(
		_context: ITerminalContributionContext,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
	}

	public xtermReady(screen: IXtermTerminal): void {
		const element = screen.raw.element;
		if (!element) return;
		let lastOrdinaryScroll = -Infinity;
		let lastZoom = -Infinity;
		let smallPixelDelta = 0;
		this._register(
			addDisposableListener(
				element,
				'wheel',
				event => {
					const enabled = this.configuration.getValue<boolean>(TerminalZoomSettingId.MouseWheelZoom);
					const modifier = isMacintosh ? event.metaKey || event.ctrlKey : event.ctrlKey && !event.metaKey;
					// Do not turn the inertia of an ordinary scroll into a font change when
					// the modifier is pressed halfway through that scroll.
					if (
						!enabled ||
						!modifier ||
						event.shiftKey ||
						event.altKey ||
						event.timeStamp - lastOrdinaryScroll <= 50
					) {
						lastOrdinaryScroll = event.timeStamp;
						smallPixelDelta = 0;
						return;
					}
					if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					if (event.timeStamp - lastZoom > 50) smallPixelDelta = 0;
					lastZoom = event.timeStamp;
					let change = -Math.sign(event.deltaY);
					if (event.deltaMode === 0 && Math.abs(event.deltaY) < 5) {
						// Smooth trackpads produce many sub-pixel events. Accumulate travel
						// before changing a pixel, while a wheel tick changes at most one.
						smallPixelDelta -= event.deltaY;
						change = Math.trunc(smallPixelDelta / 5);
						smallPixelDelta -= change * 5;
					} else {
						smallPixelDelta = 0;
					}
					if (change === 0) return;
					void updateFontSize(
						this.configuration,
						change,
						() =>
							!this.isDisposed &&
							!screen.isDisposed &&
							this.configuration.getValue<boolean>(TerminalZoomSettingId.MouseWheelZoom),
					).catch(onUnexpectedError);
				},
				{ capture: true, passive: false },
			),
		);
	}
}

registerTerminalContribution('terminal.mouseWheelZoom', TerminalMouseWheelZoomContribution);

for (const action of [
	{
		id: TerminalZoomCommandId.FontZoomIn,
		title: localize2('terminal.fontZoomIn.title', 'Terminal: Increase Font Size'),
		change: 1,
	},
	{
		id: TerminalZoomCommandId.FontZoomOut,
		title: localize2('terminal.fontZoomOut.title', 'Terminal: Decrease Font Size'),
		change: -1,
	},
	{
		id: TerminalZoomCommandId.FontZoomReset,
		title: localize2('terminal.fontZoomReset.title', 'Terminal: Reset Font Size'),
		change: 0,
	},
]) {
	registerAction2(
		class TerminalFontZoomAction extends Action2 {
			constructor() {
				super({ id: action.id, title: action.title, f1: true });
			}

			override async run(accessor: ServicesAccessor): Promise<void> {
				const configuration = accessor.get(IConfigurationService);
				// Keep the configuration service as the sole font-size owner. Its change
				// event updates every terminal renderer and refits each process's grid.
				await updateFontSize(configuration, action.change);
			}
		},
	);
}
