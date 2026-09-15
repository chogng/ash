import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { ThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TerminalInstanceWidget } from '../../../src/ash/workbench/contrib/terminal/browser/instance/terminalInstanceWidget.js';
import type { ITerminalInstance } from '../../../src/ash/workbench/services/terminal/common/terminal.js';

const store = new DisposableStore();
const output = store.add(new Emitter<Uint8Array>());
const exit = store.add(new Emitter<number | undefined>());
const theme = store.add(new ThemeService(darkColorTheme));
const writes: string[] = [];
const instance: ITerminalInstance = {
	...Disposable.None,
	id: 'test-terminal',
	dirId: 'workspace',
	title: 'Shell',
	profile: { profileId: 'shell', title: 'Shell', isDefault: true },
	state: 'running',
	exitCode: undefined,
	onDidWriteData: output.event,
	onDidExit: exit.event,
	onDidChangeCommandStatus: Event.None,
	onDidChangeState: Event.None,
	write: data => { writes.push(data); },
	resize: () => {},
	close: async () => {},
};
const widget = store.add(new TerminalInstanceWidget(document.querySelector<HTMLElement>('#terminal')!, instance, theme));
widget.setVisible(true);
let completion: Promise<void> | undefined;

window.ashTerminalIntegration = {
	writes,
	write: text => output.fire(new TextEncoder().encode(text)),
	exit: () => exit.fire(0),
	start: () => {
		completion = widget.initialize();
		widget.focus();
		return completion === widget.initialize();
	},
	ready: async () => { await completion; },
	dispose: () => store.dispose(),
};

declare global {
	interface Window {
		ashTerminalIntegration: {
			readonly writes: readonly string[];
			write(text: string): void;
			exit(): void;
			start(): boolean;
			ready(): Promise<void>;
			dispose(): void;
		};
	}
}
