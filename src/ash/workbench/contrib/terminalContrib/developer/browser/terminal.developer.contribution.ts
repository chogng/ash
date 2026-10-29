import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalRecorder } from '../../../../../platform/terminal/common/terminalRecorder.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalDeveloperCommandId } from '../common/terminal.developer.js';

registerAction2(
	class WriteDataToTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalDeveloperCommandId.WriteDataToTerminal,
				title: localize2('terminal.developer.writeData', 'Developer: Write Data to Terminal'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const groups = accessor.get(ITerminalGroupService);
			const editors = accessor.get(ITerminalEditorService);
			const quickInput = accessor.get(IQuickInputService);
			const instance = terminals.activeInstance ?? (await terminals.createTerminal());
			terminals.setActiveInstance(instance);
			if (instance.target === TerminalLocation.Editor) await editors.openEditor(instance);
			else await groups.showPanel(true);
			const screen = await instance.xtermReadyPromise;
			if (!screen || screen.isDisposed || !terminals.instances.includes(instance)) return;
			using lifetime = new DisposableStore();
			const cancellation = lifetime.add(new CancellationTokenSource());
			const processId = instance.processId;
			lifetime.add(instance.onDidChangeState(() => cancellation.cancel()));
			lifetime.add(terminals.onDidChangeActiveInstance(() => cancellation.cancel()));
			lifetime.add(
				terminals.onDidDisposeInstance(disposed => {
					if (disposed === instance) cancellation.cancel();
				}),
			);
			const data = await quickInput.input(
				{
					title: localize('terminal.developer.writeData', 'Developer: Write Data to Terminal'),
					placeHolder: localize(
						'terminal.developer.writeData.prompt',
						'Write display data directly to the terminal screen. Supports \\n, \\r and \\xNN escapes.',
					),
				},
				cancellation.token,
			);
			if (
				!data ||
				cancellation.token.isCancellationRequested ||
				screen.isDisposed ||
				instance.processId !== processId
			)
				return;
			// This is renderer debug data, never shell stdin. Decode only one layer so
			// a hex-escaped backslash cannot turn ordinary text into a second escape.
			const decoded = data.replace(/\\(?:n|r|x[0-9a-fA-F]{2})/g, escape =>
				escape === '\\n'
					? '\n'
					: escape === '\\r'
						? '\r'
						: String.fromCharCode(Number.parseInt(escape.slice(2), 16)),
			);
			await new Promise<void>(resolve => screen.raw.write(decoded, resolve));
			screen.focus();
		}
	},
);

registerAction2(
	class RecordTerminalSessionAction extends Action2 {
		constructor() {
			super({
				id: TerminalDeveloperCommandId.RecordSession,
				title: localize2('terminal.developer.recordSession', 'Developer: Record Terminal Session'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const groups = accessor.get(ITerminalGroupService);
			const clipboard = accessor.get(IClipboardService);
			const commands = accessor.get(ICommandService);
			const statusbar = accessor.get(IStatusbarService);
			// Subscribe before starting the child process so its first output belongs to
			// the capture. Creating a dedicated terminal makes the recording boundary clear.
			const instance = await terminals.createTerminal({ deferStart: true, location: TerminalLocation.Panel });
			using lifetime = new DisposableStore();
			terminals.setActiveInstance(instance);
			await groups.showPanel(true);
			const screen = await instance.xtermReadyPromise;
			if (!screen || screen.isDisposed || !terminals.instances.includes(instance)) {
				await terminals.safeDisposeTerminal(instance);
				return;
			}
			const dimensions = screen.dimensions();
			const recorder = new TerminalRecorder(dimensions.cols, dimensions.rows, {
				maxBytes: 5 * 1024 * 1024,
				maxChunks: 20000,
			});
			const events: { type: 'input' | 'command'; data: string }[] = [];
			let eventBytes = 0;
			let eventTruncated = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const completed = new DeferredPromise<void>();
			let stopped = false;
			const stop = (): void => {
				if (stopped) return;
				stopped = true;
				lifetime.dispose();
				void clipboard
					.writeText(
						JSON.stringify(
							{
								replay: recorder.generateReplayEventSync(),
								events,
								truncated: recorder.isTruncated || eventTruncated,
							},
							null,
							2,
						),
					)
					.then(
						() => completed.complete(),
						error => completed.error(error),
					);
			};
			const activity = (): void => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(stop, 5000);
			};
			lifetime.add(
				toDisposable(() => {
					if (timer) clearTimeout(timer);
				}),
			);
			const text = localize(
				'terminal.developer.recording',
				'Recording terminal session — select to stop and copy',
			);
			lifetime.add(
				statusbar.addEntry(
					{ text, ariaLabel: text, tooltip: text, showProgress: true, run: stop },
					{ id: `terminal.recordSession.${instance.instanceId}`, alignment: StatusbarAlignment.Left },
				),
			);
			const record = (type: 'input' | 'command', data: string): void => {
				eventBytes += data.length * 2;
				if (eventBytes > 1024 * 1024 || events.length >= 20000) {
					eventTruncated = true;
					stop();
					return;
				}
				events.push({ type, data });
				activity();
			};
			lifetime.add(
				instance.onDidWriteData(event => {
					recorder.handleData(event.data);
					activity();
				}),
			);
			const input = screen.raw.onData(data => record('input', data));
			lifetime.add(toDisposable(() => input.dispose()));
			const resized = screen.raw.onResize(size => {
				recorder.handleResize(size.cols, size.rows);
				activity();
			});
			lifetime.add(toDisposable(() => resized.dispose()));
			lifetime.add(commands.onWillExecuteCommand(event => record('command', event.commandId)));
			lifetime.add(instance.onDidExit(stop));
			lifetime.add(
				instance.onDidChangeState(state => {
					if (state !== 'running') stop();
				}),
			);
			lifetime.add(
				terminals.onDidDisposeInstance(disposed => {
					if (disposed === instance) stop();
				}),
			);
			activity();
			instance.start();
			screen.focus();
			await completed.p;
		}
	},
);
