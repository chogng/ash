import { localize } from '../../../../nls.js';
import type { ITerminalInstance } from './terminal.js';
import { IEnvironmentVariableService, type IEnvironmentVariableInfo } from '../common/environmentVariable.js';
import { EnvironmentVariableInfoChangesActive } from './environmentVariableInfo.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IHoverService, type IManagedHover } from '../../../../platform/hover/browser/hoverService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { TerminalCommandId } from '../common/terminal.js';
import Severity from '../../../../base/common/severity.js';
import { Emitter } from '../../../../base/common/event.js';
import './media/terminal.css';

/** Reads execution identity from the instance; the hover never queries or changes a Shell. */
function getShellProcessTooltip(instance: ITerminalInstance, showDetailed: boolean, environmentVariableInfo?: IEnvironmentVariableInfo): string {
	const lines = [localize('terminal.tooltip.profile', 'Profile: {0}', instance.profile.title)];
	if (instance.processId > 0) {
		lines.push(localize('terminal.tooltip.pid', 'Process ID (PID): {0}', instance.processId));
	}
	const shell = instance.shellLaunchConfig;
	// Multiple paths are launch candidates, not a confirmed command line.
	let executable: string | undefined;
	if (typeof shell?.executable === 'string') {
		executable = shell.executable;
	} else if (shell?.executable?.length === 1) {
		executable = shell.executable[0];
	}
	if (executable) {
		const processArgs = instance.injectedArgs ?? shell?.args;
		const args = typeof processArgs === 'string' ? processArgs : processArgs?.map(argument => (/\s|^$/.test(argument) ? JSON.stringify(argument) : argument)).join(' ');
		if (!showDetailed && executable.length > 32) {
			// Execution hosts can use Windows paths even when this window runs on macOS.
			const separator = Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\'));
			if (separator >= 0) {
				executable = `…${executable.slice(separator)}`;
			}
		}
		lines.push(localize('terminal.tooltip.commandLine', 'Command line: {0}', args ? `${executable} ${args}` : executable));
	}
	if (showDetailed) {
		const cwd = instance.cwd ?? instance.initialCwd;
		if (cwd && shell?.customPtyImplementation) lines.push(localize('terminal.tooltip.cwd', 'Working directory: {0}', cwd));
		if (instance.exitCode !== undefined) lines.push(localize('terminal.tooltip.exitCode', 'Exit code: {0}', instance.exitCode));
		if (!instance.shellLaunchConfig?.customPtyImplementation) {
			const environment = environmentVariableInfo?.getStatus();
			if (environment) lines.push(environment.tooltip);
		}
	}
	return `\n${lines.join('\n')}`;
}

/** Owns one instance card; process and environment state remain with their existing owners. */
export class TerminalInstanceHover extends Disposable {
	public readonly hover: IManagedHover;
	private readonly hidden = this._register(new Emitter<void>());
	readonly onDidHide = this.hidden.event;
	private readonly contentLifetime = this._register(new DisposableStore());
	private content: HTMLElement | undefined;

	constructor(
		private readonly target: HTMLElement,
		private readonly instance: ITerminalInstance,
		@IHoverService hoverService: IHoverService,
		@IStorageService private readonly storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@IEnvironmentVariableService private readonly environment: IEnvironmentVariableService,
	) {
		super();
		this.hover = this._register(
			hoverService.setupHover({
				target,
				content: () => this.createContent(),
				groupId: 'terminal-instances',
				trapFocus: true,
				onDidHide: () => {
					this.contentLifetime.clear();
					this.content = undefined;
					this.hidden.fire();
				},
			}),
		);
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope !== StorageScope.APPLICATION || event.key !== TerminalStorageKeys.TabsShowDetailed) return;
				this.refresh();
			}),
		);
		this._register(environment.onDidChangeCollections(() => this.refresh()));
		if (instance.statusList) {
			this._register(instance.statusList.onDidAddStatus(() => this.refresh()));
			this._register(instance.statusList.onDidRemoveStatus(() => this.refresh()));
		}
		this._register(instance.onDidChangeState(() => this.refresh()));
		// Enter retains terminal activation/menu semantics. This separate shortcut
		// enters the card from either the title toolbar or a focused terminal row.
		this._register(
			addDisposableListener(
				target,
				'keydown',
				event => {
					if (!event.altKey || event.key !== 'ArrowDown') return;
					event.preventDefault();
					event.stopImmediatePropagation();
					this.focus();
				},
				true,
			),
		);
	}

	public focus(): void {
		this.hover.show();
		this.content?.querySelector<HTMLButtonElement>('button')?.focus();
	}

	private refresh(): void {
		const activeElement = this.target.ownerDocument.activeElement;
		const focusedAction = this.content?.contains(activeElement) ? (activeElement as HTMLElement).dataset.terminalHoverAction : undefined;
		this.hover.update(() => this.createContent());
		if (focusedAction) this.content?.querySelector<HTMLElement>(`[data-terminal-hover-action="${focusedAction}"]`)?.focus();
	}

	private createContent(): HTMLElement {
		this.contentLifetime.clear();
		const document = this.target.ownerDocument;
		const card = (this.content = h(document, 'div'));
		card.className = 'ash-terminal-instance-hover';
		const title = h(document, 'div');
		title.className = 'ash-terminal-instance-hover-title';
		title.textContent = this.instance.title;
		const details = this.storage.getBoolean(TerminalStorageKeys.TabsShowDetailed, StorageScope.APPLICATION, false);
		const process = h(document, 'div');
		process.className = 'ash-terminal-instance-hover-section';
		process.textContent = getShellProcessTooltip(this.instance, details, new EnvironmentVariableInfoChangesActive(this.environment.collections)).trim();
		card.append(title, process);
		const statuses = this.instance.statusList?.statuses ?? [];
		for (const status of statuses) {
			const section = h(document, 'div');
			section.className = 'ash-terminal-instance-hover-section';
			if (status.icon) {
				appendIcon(status.icon, section);
				section.append(' ');
			}
			section.append(details ? (status.detailedTooltip ?? status.tooltip) : status.tooltip);
			if (status.severity === Severity.Error) {
				section.dataset.severity = 'error';
			} else if (status.severity === Severity.Warning) {
				section.dataset.severity = 'warning';
			}
			card.append(section);
		}
		const actions = h(document, 'div');
		actions.className = 'ash-terminal-instance-hover-actions';
		const addAction = (id: string, label: string, run: () => void): HTMLButtonElement => {
			const button = h(document, 'button');
			button.type = 'button';
			button.textContent = label;
			button.dataset.terminalHoverAction = id;
			this.contentLifetime.add(addDisposableListener(button, 'click', run));
			actions.append(button);
			return button;
		};
		if (!this.instance.shellLaunchConfig?.customPtyImplementation && this.instance.resource) {
			addAction('environment', localize('terminal.tooltip.environment', 'Show Environment Contributions'), () => {
				this.hover.hide();
				void this.commands.executeCommand(TerminalCommandId.ShowEnvironmentContributions, this.instance.resource).catch(onUnexpectedError);
			});
		}
		for (const status of statuses) {
			for (const action of status.hoverActions ?? []) {
				addAction(action.commandId, action.label, () => {
					this.hover.hide();
					action.run();
				});
			}
		}
		const toggle = addAction('details', details ? localize('terminal.tooltip.hideDetails', 'Hide Details') : localize('terminal.tooltip.showDetails', 'Show Details'), () => {
			this.storage.store(TerminalStorageKeys.TabsShowDetailed, !details, StorageScope.APPLICATION, StorageTarget.USER);
		});
		toggle.setAttribute('aria-expanded', String(details));
		card.append(actions);
		return card;
	}
}
