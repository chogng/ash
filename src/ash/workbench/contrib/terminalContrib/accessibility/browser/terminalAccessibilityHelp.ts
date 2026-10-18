import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewContentProvider } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ITerminalInstance } from '../../../../services/terminal/browser/terminal.js';

export class TerminalAccessibilityHelpProvider extends Disposable implements IAccessibleViewContentProvider {
	public readonly id = AccessibleViewProviderId.TerminalHelp;
	public readonly options = { type: AccessibleViewType.Help };
	public readonly verbositySettingKey = AccessibilityVerbositySettingId.Terminal;

	constructor(private readonly instance: ITerminalInstance) { super(); }

	public provideContent(): string {
		return [
			localize('terminal.accessibility.workspaceFolders', 'In a multi-root workspace, new terminals use the active file folder or ask you to select a folder. Escape cancels selection. Split terminals keep their parent folder. Workspace folder changes preserve terminals belonging to retained folders.'),
			localize('terminal.accessibility.overview', 'The terminal sends typed input to its running process. <keybinding:editor.action.accessibleView> opens the retained screen and scrollback as read-only text.'),
			localize('terminal.accessibility.find', '<keybinding:workbench.action.terminal.focusFind> opens Find. Enter and Shift+Enter navigate its matches. Escape returns focus to the terminal.'),
			localize('terminal.accessibility.links', '<keybinding:workbench.action.terminal.openDetectedLink> opens a searchable list of file paths and web links. Enter opens the selected file at its reported line and column, or opens the web link. Escape returns focus to the terminal. File paths in output can also be clicked; relative paths use the command’s working directory when available.'),
			localize('terminal.accessibility.commandNavigation', 'Terminal: Scroll to Previous Command and Terminal: Scroll to Next Command move between shell commands. Terminal: Run Recent Command opens saved commands; selecting one runs it in the current terminal.'),
			localize('terminal.accessibility.commandMarkers', 'Shell integration marks each command prompt. An outlined circle means input is pending or the command is running; a filled circle means success, and an error icon means failure. Hover over a marker for its status and exit code. The overview ruler also shows command status, with failed commands in its right lane. Ordinary output lines have no command marker.'),
			localize('terminal.accessibility.clipboard', '<keybinding:workbench.action.terminal.copySelection> copies selected terminal text. <keybinding:workbench.action.terminal.paste> pastes clipboard text into the active running terminal. Without a selection, Ctrl+C is sent to the process.'),
			localize('terminal.accessibility.runSelectedText', 'From the code editor, Terminal: Run Selected Text in Active Terminal runs the selected text, or the current line when nothing is selected. It creates a terminal when needed and keeps focus in the code editor.'),
			localize('terminal.accessibility.interrupt', 'Terminal: Interrupt Active Command sends SIGINT through the execution host to the foreground command without closing the terminal.'),
			localize('terminal.accessibility.sendSequence', 'Terminal: Send Sequence sends text or control characters to the active running terminal without adding Enter. The input accepts \\n, \\r and \\xNN escapes. Keybindings can supply a text argument; configuration variables are resolved before sending. Environment variables use the current verified shell environment when available, otherwise the execution host environment.'),
			localize('terminal.accessibility.metadata', 'Terminal: Rename opens a name input; Enter applies the name, Escape cancels, and an empty name restores the shell name. Terminal: Change Icon opens a searchable icon list. Both actions also appear in the terminal instance menu and preserve the running process.'),
			localize('terminal.accessibility.editor', 'Terminal: Move Terminal into Editor Area moves the current terminal into an editor tab while retaining its process and output. Move Terminal into Panel returns it to the panel. Closing a terminal editor tab closes its process.'),
			localize('terminal.accessibility.groups', 'Terminal: Split Terminal creates another shell beside the current terminal. Focus Next Pane and Focus Previous Pane move focus between the split terminals. The instance list keeps split terminals together and announces each pane’s position in its group. Their resize separator supports arrow keys. Unsplit Terminal moves the current pane to its own group while keeping its process and output.'),
			localize('terminal.accessibility.tabsMenu', 'In the terminal instance list, arrow keys move focus and Enter activates a terminal. Shift+F10 opens the focused terminal menu. Its focus, clear, relaunch and kill actions apply to that terminal even if the active terminal changes. Escape closes the menu and restores focus.'),
			localize('terminal.accessibility.titleToolbar', 'The terminal title opens its instance menu. Alt+click splits it; middle-click closes it. The New Terminal dropdown offers profiles, split actions and Select Default Profile. Use arrow keys to navigate the toolbar and menus; Escape closes a menu and restores focus.'),
			localize('terminal.accessibility.profiles', 'New Terminal with Profile opens a searchable list of discovered, configured and extension profiles. Use arrow keys and Enter to choose; Escape cancels. Select Default Profile applies to future terminals. Relaunch keeps the original shell configuration. Extension profiles activate their provider when selected.'),
			localize('terminal.accessibility.taskGroups', 'Tasks with the same presentation.group open in split panes. Focus Next Pane and Focus Previous Pane navigate them. Manage Automatic Tasks enables or disables folder-open tasks in trusted workspaces; automatic tasks are disabled by default.'),
			localize('terminal.accessibility.reuse', 'A completed task waits for a character key or Enter to close its terminal. Workbench shortcuts remain available. presentation.showReuseMessage controls the reuse notice. A new task terminal displays a close notice.'),
			localize('terminal.accessibility.close', 'Escape closes accessibility help or the accessible view and returns focus to the terminal.'),
		].join('\n\n');
	}

	protected override disposeCore(): void {
		const screen = this.instance.xterm;
		if (screen && !screen.isDisposed) screen.focus();
	}
}
