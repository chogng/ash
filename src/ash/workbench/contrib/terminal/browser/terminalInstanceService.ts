import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AgentHostTerminalService } from './agentHostTerminalService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { TerminalProcessConnectionState } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalCreateOptions, ITerminalProfile } from '../../../services/terminal/browser/terminal.js';
import { TerminalInstance } from './terminalInstance.js';

interface InstanceCreationCallbacks {
	readonly getConnectionState: () => TerminalProcessConnectionState;
	readonly onClosed: (instance: TerminalInstance) => void;
	readonly onTitleChanged: () => void;
}

/** Creates ready instances; membership and active selection remain with TerminalService. */
export class TerminalInstanceService extends Disposable {
	private nextInstanceId = 1;
	readonly backend: AgentHostTerminalService;
	constructor(
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.backend = this._register(instantiationService.createInstance(AgentHostTerminalService));
	}
	async createInstance(options: ITerminalCreateOptions, callbacks: InstanceCreationCallbacks): Promise<TerminalInstance> {
		if (this.isDisposed) {
			throw new CancellationError();
		}
		if (options.config) {
			const instanceNumber = this.nextInstanceId++;
			const workspaceFolder = options.dirId === undefined ? undefined : this.requireWorkspaceFolder(options.dirId);
			const name = options.title ?? options.config.name ?? '';
			const instance = this.instantiationService.createInstance(TerminalInstance,
				`terminal-instance-${instanceNumber}`,
				instanceNumber,
				workspaceFolder?.id ?? '',
				workspaceFolder && this.workspaceContext.getWorkspace().folders.length > 1 ? workspaceFolder.id : undefined,
				undefined,
				{ pid: -1, cwd: '' },
				name,
				{ profileId: `embedder-${instanceNumber}`, title: name, isDefault: false, icon: options.icon ?? options.config.icon, color: options.color ?? options.config.color },
				'connectionOwned',
				name,
				callbacks.getConnectionState,
				() => callbacks.onClosed(instance),
				callbacks.onTitleChanged,
				{
					create: options.config.customPtyImplementation,
					instanceNumber,
					dimensions: options.dimensions,
					onTitleChanged: callbacks.onTitleChanged,
				},
				undefined,
				options.initialText ?? options.config.initialText,
				options.waitOnExit ?? options.config.waitOnExit,
				options.dimensions,
				this.backend,
			);
			return instance;
		}
		const workspaceFolder = this.requireWorkspaceFolder(options.dirId);
		// A Session directory needs its execution route even when it is the only visible folder.
		const processWorkspaceFolderId = this.workspaceContext.getWorkspace().folders.length > 1 || workspaceFolder.id.startsWith('session:')
			? workspaceFolder.id
			: undefined;
		const environment = options.env === undefined ? undefined : Object.freeze({ ...options.env });
		const execution = options.execution === undefined ? undefined : Object.freeze(options.execution.type === 'process'
			? { ...options.execution, args: (typeof options.execution.args === 'string' ? options.execution.args : Object.freeze([...options.execution.args])) }
			: { ...options.execution });
		const profile = options.profile.type === 'custom' ? Object.freeze({ ...options.profile, path: Object.freeze([...options.profile.path]), args: (typeof options.profile.args === 'string' ? options.profile.args : Object.freeze([...options.profile.args])) }) : Object.freeze({ ...options.profile });
		const launch = Object.freeze({
			...(environment === undefined ? {} : { env: environment }),
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(execution === undefined ? {} : { execution }),
		});
		const instanceNumber = this.nextInstanceId++;
		const child = await this.backend.createProcess({
			...processWorkspaceFolder(processWorkspaceFolderId),
			rows: options.dimensions.rows,
			cols: options.dimensions.cols,
			profile,
			...(environment === undefined ? {} : { env: environment }),
			...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
			...(execution === undefined ? {} : { execution }),
		}, instanceNumber);
		const created = child.creation;
		// A completed backend request still owns a PTY even if its window has closed.
		if (this.isDisposed) {
			await child.close();
			throw new CancellationError();
		}
		const instance = this.instantiationService.createInstance(TerminalInstance,
			`terminal-instance-${instanceNumber}`,
			instanceNumber,
			workspaceFolder.id,
			processWorkspaceFolderId,
			child,
			created.ready,
			options.title ?? terminalProfileTitle(created.profile),
			{ ...created.profile, icon: options.icon, color: options.color },
			created.connectionPersistence,
			options.title,
			callbacks.getConnectionState,
			() => callbacks.onClosed(instance),
			callbacks.onTitleChanged,
			undefined,
			Object.freeze({ ...launch, profile: profile.type === 'custom' ? profile : { type: 'profile' as const, profileId: created.profile.profileId } }),
			options.initialText,
			options.waitOnExit,
			options.dimensions,
			this.backend,
		);
		return instance;
	}

	private requireWorkspaceFolder(dirId?: string) {
		const folders = this.workspaceContext.getWorkspace().folders;
		const folder = dirId ? folders.find(folder => folder.id === dirId) : folders[0];
		if (!folder) throw new Error("TerminalUnavailable: Terminal requires an open workspace folder");
		return folder;
	}

}

function processWorkspaceFolder(dirId: string | undefined): { readonly dirId?: string; } {
	return dirId === undefined ? {} : { dirId };
}

function terminalProfileTitle(profile: ITerminalProfile): string {
	if (profile.profileId === "cmd" || profile.profileId === "command-prompt") {
		return "cmd";
	}
	return profile.title;
}
