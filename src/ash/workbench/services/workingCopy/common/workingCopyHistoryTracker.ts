import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IExpression } from '../../../../base/common/glob.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ResourceGlobMatcher } from '../../../common/resources.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { ITextFileService } from '../../textfile/common/textFileService.js';
import { IWorkingCopyHistoryService } from './workingCopyHistory.js';
import '../../filesConfiguration/common/filesConfigurationService.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
registry.registerConfiguration({
	key: 'workbench.localHistory.enabled', defaultValue: true, scope: ConfigurationScope.RESOURCE, parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('localHistory.invalidEnabled', 'Local history enabled must be a boolean.'));
		return value;
	}, setting: { valueType: 'boolean', title: localize('localHistory.enabledTitle', 'Local history'), description: localize('localHistory.enabledDescription', 'Keep saved file versions in the current UI profile.') }
});
registry.registerConfiguration({
	key: 'workbench.localHistory.maxFileSize', defaultValue: 256, scope: ConfigurationScope.RESOURCE, parse(value: unknown): number {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 32768) throw new TypeError(localize('localHistory.invalidSize', 'Local history file size must be between 0 and 32768 KB.'));
		return value;
	}, setting: { valueType: 'number', minimum: 0, maximum: 32768, title: localize('localHistory.sizeTitle', 'Local history file size limit'), description: localize('localHistory.sizeDescription', 'Maximum saved file size in KB to include in local history.') }
});

/** Records successful saves; dirty buffers and crash recovery retain their existing owners. */
export class WorkingCopyHistoryTracker extends Disposable {
	private readonly pending = new Set<Promise<unknown>>();

	constructor(
		@ITextFileService textFiles: ITextFileService,
		@IWorkingCopyHistoryService history: IWorkingCopyHistoryService,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ILogService log: ILogService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		const excludes = this._register(new ResourceGlobMatcher(() => configuration.getValue<IExpression>('workbench.localHistory.exclude'), event => event.affectsConfiguration('workbench.localHistory.exclude'), workspace, configuration));
		this._register(textFiles.onDidSave(event => {
			if (event.resource.scheme !== Schemas.file && !isRemoteResource(event.resource) || !configuration.getValue<boolean>('workbench.localHistory.enabled') || excludes.matches(event.resource) || new TextEncoder().encode(event.content).byteLength > configuration.getValue<number>('workbench.localHistory.maxFileSize') * 1024) return;
			const operation = history.addEntry({ resource: event.resource, content: event.content }, CancellationToken.None).catch(error => log.error('localHistory', 'Could not record a saved file', error));
			this.pending.add(operation);
			void operation.finally(() => this.pending.delete(operation));
		}));
		this._register(lifecycle.onWillShutdown(event => event.join(this.flush(), 'local history writes')));
	}

	public async flush(): Promise<void> {
		await Promise.all(this.pending);
	}
}
