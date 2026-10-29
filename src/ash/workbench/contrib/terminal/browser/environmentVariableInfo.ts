import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import type { ITerminalStatus } from '../common/terminal.js';
import type { IEnvironmentVariableCollectionWithPersistence, IEnvironmentVariableInfo } from '../common/environmentVariable.js';

/** Read-only information about future launches, independent of a running process's environment. */
export class EnvironmentVariableInfoChangesActive implements IEnvironmentVariableInfo {
	readonly requiresAction = false;

	constructor(private readonly collections: ReadonlyMap<string, IEnvironmentVariableCollectionWithPersistence>) {}

	getStatus(): ITerminalStatus | undefined {
		const extensions = [...this.collections]
			.filter(([, collection]) => collection.map.size)
			.map(([id]) => id)
			.sort();
		if (!extensions.length) return undefined;
		return {
			id: 'environment-variable-changes-active',
			severity: this.requiresAction ? Severity.Warning : Severity.Info,
			tooltip: localize('terminal.environment.activeInfo', 'Extensions configure the environment for new terminals: {0}', extensions.join(', ')),
		};
	}
}
