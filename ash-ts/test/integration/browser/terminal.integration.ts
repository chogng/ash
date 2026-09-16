import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { TerminalInstanceWidget } from '../../../src/ash/workbench/contrib/terminal/browser/instance/terminalInstanceWidget.js';
import type { ITerminalDimensions, ITerminalInstance } from '../../../src/ash/workbench/services/terminal/common/terminal.js';

const store = new DisposableStore();
const output = store.add(new Emitter<Uint8Array>());
const exit = store.add(new Emitter<number | undefined>());
const theme = store.add(new TestThemeService(darkColorTheme));
const writes: string[] = [];
const resizes: ITerminalDimensions[] = [];
const instance: ITerminalInstance = {
	...Disposable.None,
	id: 'test-terminal',
	dirId: 'workspace',
	title: 'Shell',
	profile: { profileId: 'shell', title: 'Shell', isDefault: true },
	state: new URLSearchParams(location.search).has('exited') ? 'exited' : 'running',
	exitCode: undefined,
	onDidWriteData: output.event,
	onDidExit: exit.event,
	onDidChangeCommandStatus: Event.None,
	onDidChangeState: Event.None,
	write: data => { writes.push(data); },
	resize: dimensions => { resizes.push(dimensions); },
	close: async () => {},
};
const widget = store.add(new TerminalInstanceWidget(document.querySelector<HTMLElement>('#terminal')!, instance, theme));
widget.setVisible(true);
let completion: Promise<void> | undefined;

window.ashTerminalIntegration = {
	writes,
	resizes,
	fit: () => widget.fit(),
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
			readonly resizes: readonly ITerminalDimensions[];
			fit(): void;
			write(text: string): void;
			exit(): void;
			start(): boolean;
			ready(): Promise<void>;
			dispose(): void;
		};
	}
}

// Exercise the production pane with controlled process and workspace boundaries.
if (new URLSearchParams(location.search).has('pane')) {
	widget.dispose();
	const [{ TerminalViewPane }, { ContextKeyService }, { MenuService }, { ServiceContainer }, { CommandService }, { URI }] = await Promise.all([
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js'),
		import('../../../src/ash/platform/contextkey/common/contextkey.js'),
		import('../../../src/ash/platform/actions/common/menuService.js'),
		import('../../../src/ash/platform/instantiation/common/instantiation.js'),
		import('../../../src/ash/workbench/services/commands/common/commandService.js'),
		import('../../../src/ash/base/common/uri.js'),
	]);
	const visibility = store.add(new Emitter<import('../../../src/ash/workbench/services/layout/common/workbenchLayoutService.js').WorkbenchPartVisibilityChangeEvent>());
	const workspaceChanged = store.add(new Emitter<import('../../../src/ash/platform/workspace/common/workspace.js').IWorkspaceChangeEvent>());
	const created = store.add(new Emitter<ITerminalInstance>());
	const context = store.add(new ContextKeyService());
	const commands = new CommandService(new ServiceContainer());
	const menu = new MenuService(commands, context);
	let visible = false;
	let selected = true;
	let profiles = 0;
	let creates = 0;
	let release: (() => void) | undefined;
	let pending: Promise<void> = Promise.resolve();
	const instances: ITerminalInstance[] = new URLSearchParams(location.search).has('existing') ? [instance] : [];
	const workspace = { id: 'workspace', folders: [{ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }] };
	const setPanel = (value: boolean): void => {
		visible = value;
		visibility.fire({ partId: 'panel', visible });
		pane.setVisible(visible && selected);
	};
	const pane = store.add(new TerminalViewPane(document.querySelector<HTMLElement>('#terminal')!, { id: 'terminal', title: 'Terminal' }, {
		...Disposable.None,
		instances,
		get activeInstance() { return instances[0]; },
		onDidCreateInstance: created.event,
		onDidDisposeInstance: Event.None,
		onDidChangeInstances: Event.None,
		onDidChangeActiveInstance: Event.None,
		getProfiles: async () => { profiles++; await pending; return [instance.profile]; },
		createTerminal: async () => { creates++; instances.push(instance); created.fire(instance); return instance; },
		relaunchTerminal: async () => { await pending; },
		setActiveInstance: () => {},
		moveTerminal: () => {},
		closeTerminal: async () => {},
	}, theme, menu, {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: () => {},
		hideContextMenu: () => {},
	}, context, {
		onDidChangePartVisibility: visibility.event,
		isPartVisible: () => visible,
		isPanelMaximized: () => false,
		showPart: () => setPanel(true),
		showParts: () => setPanel(true),
		hidePart: () => setPanel(false),
		hideParts: () => setPanel(false),
		getPartSize: () => ({ width: 800, height: 400 }),
		resizePart: () => {},
	}, {
		onDidChangeWorkspace: workspaceChanged.event,
		getWorkspace: () => workspace,
		getWorkbenchState: () => 2,
	}));
	document.querySelector<HTMLElement>('#terminal')!.append(pane.partTitleProjection.actions!);
	window.ashTerminalPaneIntegration = {
		counts: () => ({ profiles, creates }),
		panel: setPanel,
		view: value => { selected = value; pane.setVisible(visible && selected); },
		expand: value => pane.setExpanded(value),
		focus: () => pane.focus(),
		workspace: () => workspaceChanged.fire({ previous: workspace, workspace }),
		hold: () => { pending = new Promise<void>(resolve => { release = resolve; }); },
		release: () => release?.(),
	};
}

declare global {
	interface Window {
		ashTerminalPaneIntegration: {
			counts(): { profiles: number; creates: number };
			panel(visible: boolean): void;
			view(visible: boolean): void;
			expand(expanded: boolean): boolean;
			focus(): void;
			workspace(): void;
			hold(): void;
			release(): void;
		};
	}
}
