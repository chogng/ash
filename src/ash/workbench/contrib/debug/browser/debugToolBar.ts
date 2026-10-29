import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { CONTEXT_DEBUG_UX } from '../common/debug.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IAction } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDebugService, type IDebugSession } from '../common/debug.js';
import './media/debugToolBar.css';

type DebugOperation = 'continue' | 'pause' | 'restart' | 'stepOver' | 'stepInto' | 'stepOut' | 'stop' | 'stopAll';

/** Owns inline session controls, localized status and their DOM lifetime. */
export class DebugToolBar extends Disposable {
	private readonly status: HTMLElement;
	private error: string | undefined;
	private readonly sessions: HTMLSelectElement;
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		container: HTMLElement,
		@IDebugService private readonly debug: IDebugService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextKeyService private readonly contexts: IContextKeyService,
	) {
		super();
		const controls = h(container.ownerDocument, 'div');
		controls.className = 'ash-debug-controls';
		this.status = h(container.ownerDocument, 'div');
		this.status.className = 'ash-debug-status';
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		container.append(controls, this.status);
		this._register(
			toDisposable(() => {
				controls.remove();
				this.status.remove();
			}),
		);
		this.sessions = h(container.ownerDocument, 'select');
		this.toolbar = this._register(
			new WorkbenchToolBar(controls, contextMenus, {
				ariaLabel: localize('debug.controls', 'Debug controls'),
				actionViewItemProvider: (action, options) => {
					if (action.id !== 'ash.debug.stop' || this.debug.sessions.length < 2) {
						return undefined;
					}
					const label = localize('debug.stopActions', 'More Stop Actions');
					return new DropdownWithPrimaryActionViewItem(
						action,
						{
							id: 'ash.debug.stopActions',
							label,
							tooltip: label,
							enabled: true,
							run: () => {},
						},
						[this.debugAction('stopAll', localize('debug.stopAll', 'Stop All'), Lxicon.square)],
						contextMenus,
						options,
					);
				},
			}),
		);
		controls.prepend(this.sessions);
		this._register(toDisposable(() => this.sessions.remove()));
		this._register(
			addDisposableListener(this.sessions, 'change', () => {
				const session = this.debug.sessions.find(candidate => candidate.id === this.sessions.value);
				if (session) {
					this.debug.setActiveSession(session);
				}
			}),
		);
		this._register(
			contexts.onDidChangeContext(event => {
				if (event.affectsSome(new Set(['debugUx']))) this.render();
			}),
		);
		this._register(
			debug.onDidChangeSession(() => {
				this.error = undefined;
				this.render();
			}),
		);
		this._register(debug.onDidNewSession(() => this.render()));
		this._register(
			debug.getViewModel().onDidFocusStackFrame(() => {
				this.error = undefined;
				this.render();
			}),
		);
		this.render();
	}

	private control(operation: DebugOperation): void {
		this.error = undefined;
		this.render();
		let action: Promise<unknown>;
		switch (operation) {
			case 'restart':
				action = this.debug.restart();
				break;
			case 'stop':
				action = this.debug.stop();
				break;
			case 'stopAll':
				action = this.debug.stopAll();
				break;
			default: {
				const session = this.debug.session;
				if (!session) {
					return;
				}
				action = session[operation]();
			}
		}
		void action.catch(error => {
			if (!isCancellationError(error)) {
				this.error = error instanceof Error ? error.message : String(error);
				this.render();
			}
		});
	}

	private debugAction(operation: DebugOperation, label: string, icon: IAction['icon'], enabled = true): IAction {
		return {
			id: `ash.debug.${operation}`,
			label,
			tooltip: label,
			icon,
			enabled,
			run: () => this.control(operation),
		};
	}

	private render(): void {
		if (this.isDisposed) {
			return;
		}
		const session = this.debug.session;
		const inspection = this.contexts.contextMatchesRules(CONTEXT_DEBUG_UX.isEqualTo('default'));
		const controls = this.sessions.parentElement!;
		controls.hidden = !inspection;
		controls.classList.toggle('empty', !inspection);
		this.status.textContent = this.error ?? (session ? `${session.name}: ${sessionStateLabel(session.state)}${session.reason ? ` (${session.reason})` : ''}` : '');
		this.status.hidden = !this.status.textContent;
		this.status.classList.toggle('empty', !this.status.textContent);
		this.status.classList.toggle('error', this.error !== undefined);
		const active = session !== undefined && session.state !== 'terminated' && session.state !== 'error';
		const stopped = session?.state === 'stopped';
		this.toolbar.element.hidden = !active;
		this.toolbar.element.classList.toggle('empty', !active);
		this.toolbar.element.setAttribute('aria-label', localize('debug.controls', 'Debug controls'));
		this.toolbar.setActions(
			active
				? [
						stopped
							? this.debugAction('continue', localize('debug.continue', 'Continue'), Lxicon.play)
							: this.debugAction('pause', localize('debug.pause', 'Pause'), Lxicon.pause, session.state === 'running'),
						this.debugAction('stepOver', localize('debug.stepOver', 'Step Over'), Lxicon.arrowRight, stopped),
						this.debugAction('stepInto', localize('debug.stepInto', 'Step Into'), Lxicon.arrowDown, stopped),
						this.debugAction('stepOut', localize('debug.stepOut', 'Step Out'), Lxicon.arrowUp, stopped),
						this.debugAction('restart', localize('debug.restart', 'Restart'), Lxicon.refresh, session.state !== 'starting'),
						this.debugAction('stop', localize('debug.stop', 'Stop'), Lxicon.square),
					]
				: [],
		);
		this.sessions.setAttribute('aria-label', localize('debug.session', 'Active debug session'));
		this.sessions.replaceChildren(
			...this.debug.sessions.map(candidate => {
				const option = h(this.sessions.ownerDocument, 'option');
				option.value = candidate.id;
				option.textContent = `${candidate.name} — ${sessionStateLabel(candidate.state)}`;
				return option;
			}),
		);
		if (session) {
			this.sessions.value = session.id;
		}
		this.sessions.hidden = this.debug.sessions.length < 2;
	}
}

function sessionStateLabel(state: IDebugSession['state']): string {
	switch (state) {
		case 'starting':
			return localize('debug.state.starting', 'starting');
		case 'running':
			return localize('debug.state.running', 'running');
		case 'stopped':
			return localize('debug.state.stopped', 'stopped');
		case 'terminated':
			return localize('debug.state.terminated', 'terminated');
		case 'error':
			return localize('debug.state.error', 'error');
	}
}
