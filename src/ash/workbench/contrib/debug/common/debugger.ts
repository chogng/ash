import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { normalizeDebugAdapterDescriptor } from '../../../services/debug/common/debugAdapterFactory.js';
import type { IDebugConfiguration } from '../../../services/debug/common/debugService.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';

/** Owns the executable debug configuration; the session retains its source for restart. */
export class Debugger {
	constructor(
		@IConfigurationResolverService private readonly resolver: IConfigurationResolverService,
		@IExtensionService private readonly extensions: IExtensionService,
	) { }

	public async substituteVariables(folder: IWorkspaceFolder | undefined, config: IDebugConfiguration): Promise<IDebugConfiguration | undefined> {
		// Command variables receive launch.json fields rather than the Workbench's session identity.
		const execution = await this.resolver.resolveWithInteractionReplace(folder, {
			...config.arguments,
			name: config.name,
			type: config.type,
			request: config.request,
			...(config.adapter === undefined ? {} : { debugAdapter: config.adapter }),
			...(config.preLaunchTask === undefined ? {} : { preLaunchTask: config.preLaunchTask }),
			...(config.postDebugTask === undefined ? {} : { postDebugTask: config.postDebugTask }),
		}, 'launch', this.extensions.debugAdapters.get(config.type)?.variables);
		if (!execution) {
			return undefined;
		}
		const { name, type, request, debugAdapter, preLaunchTask, postDebugTask, ...args } = execution;
		// Substitution crosses into a process boundary. A command result must not turn
		// a previously valid executable into an empty or malformed process argument.
		if (debugAdapter && !debugAdapter.connection && !debugAdapter.inline && (!debugAdapter.program.trim() || [debugAdapter.program, ...debugAdapter.arguments].some(value => value.includes('\0')))) {
			throw new Error(localize('debug.invalidResolvedAdapter', 'The resolved debug adapter executable is empty or contains an invalid process argument.'));
		}
		return {
			...config,
			adapter: debugAdapter?.connection ? normalizeDebugAdapterDescriptor(debugAdapter, config.name) : debugAdapter,
			arguments: args,
			preLaunchTask,
			postDebugTask,
		};
	}
}
