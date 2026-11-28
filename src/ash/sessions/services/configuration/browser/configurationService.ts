import { DeferredPromise } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import type { IConfigurationOverrides } from '../../../../platform/configuration/common/configuration.js';
import { SESSIONS_DIFF_VIEW_MODE, SESSIONS_DIFF_WORD_WRAP, SESSIONS_EDITOR_WORD_WRAP } from '../common/editorConfiguration.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import { WorkspaceService, type WorkspaceServiceOptions } from '../../../../workbench/services/configuration/browser/configurationService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IAnyWorkspaceIdentifier, IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';

const editorOverrides: ReadonlyMap<string, string> = new Map([
	['diffEditor.renderSideBySide', SESSIONS_DIFF_VIEW_MODE],
	['diffEditor.useInlineViewWhenSpaceIsLimited', SESSIONS_DIFF_VIEW_MODE],
	['diffEditor.wordWrap', SESSIONS_DIFF_WORD_WRAP],
	['editor.wordWrap', SESSIONS_EDITOR_WORD_WRAP],
]);

/** Resolves Agents Window defaults without changing the shared settings resource. */
export class ConfigurationService extends WorkspaceService {
	private workspaceProjection: { readonly resolution: Promise<IWorkspace>; readonly settled: DeferredPromise<void>; } | undefined;

	override readonly onDidChangeConfiguration = Event.map(this.configurationChanges, event => {
		const keys = [...editorOverrides].filter(([, setting]) => event.affectsConfiguration(setting)).map(([key]) => key);
		return {
			...event,
			affectedKeys: new Set([...event.affectedKeys, ...keys]),
			change: { ...event.change, keys: [...event.change.keys, ...keys] },
			affectsConfiguration: (section: string, overrides?: IConfigurationOverrides) =>
				event.affectsConfiguration(section, overrides) || keys.some(key => key === section || key.startsWith(section + '.')),
		};
	});

	protected override resolveSection(section: string, overrides?: IConfigurationOverrides): unknown {
		const setting = editorOverrides.get(section);
		const value = setting && super.resolveSection(setting, overrides);
		if (value !== undefined && value !== 'inherit') {
			if (section === 'diffEditor.renderSideBySide') return value !== 'inline';
			if (section === 'diffEditor.useInlineViewWhenSpaceIsLimited') return value === 'automatic';
			return value;
		}
		return super.resolveSection(section, overrides);
	}

	constructor(
		options: Omit<WorkspaceServiceOptions, 'defaults' | 'readOnlyKeys'> = {},
		@IFileService files: IFileService,
		@ILogService log: ILogService,
		@IUserDataProfileService profile: IUserDataProfileService,
	) {
		super(options, files, log, profile);
	}

	public override async getCompleteWorkspace(): Promise<IWorkspace> {
		await super.getCompleteWorkspace();
		let projection: typeof this.workspaceProjection;
		do {
			projection = this.workspaceProjection;
			await projection?.settled.p;
		} while (projection !== this.workspaceProjection);
		return this.getWorkspace();
	}

	public override updateWorkspace(workspace: IAnyWorkspaceIdentifier | IWorkspace, resolvedWorkspace?: Promise<IWorkspace>): void {
		const previous = this.workspaceProjection;
		if (previous && previous.resolution === resolvedWorkspace) {
			return;
		}
		const projection = resolvedWorkspace && { resolution: resolvedWorkspace, settled: new DeferredPromise<void>() };
		this.workspaceProjection = projection;
		void previous?.settled.complete();
		if (projection) {
			void projection.resolution.then(resolved => {
				// A late folder binding only belongs to the selection that requested this projection.
				if (!this.isDisposed && this.workspaceProjection === projection) {
					super.updateWorkspace(resolved);
				}
			}).catch(onUnexpectedError).finally(() => projection.settled.complete());
		}
		super.updateWorkspace(workspace);
	}

	protected override disposeCore(): void {
		void this.workspaceProjection?.settled.complete();
		this.workspaceProjection = undefined;
		super.disposeCore();
	}

	protected override defaultValue(configuration: IRegisteredConfiguration): unknown {
		return configuration.agentsWindow ? configuration.agentsWindow.default : super.defaultValue(configuration);
	}

	protected override isReadOnly(key: string): boolean {
		// Resolve current registrations so extension reloads cannot leave stale window rules.
		return this.registry.getConfiguration(key)?.agentsWindow?.readOnly === true;
	}
}
