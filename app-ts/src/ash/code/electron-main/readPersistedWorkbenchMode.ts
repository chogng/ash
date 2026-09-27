import { readFileSync } from 'node:fs';
import { parseJsonc } from '../../base/common/jsonc.js';
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry, type WorkbenchModeId } from '../../workbench/common/workbenchMode.js';

/** Reads the preferred startup mode without making the full configuration service a bootstrap dependency. */
export function readPersistedWorkbenchModeId(configurationFilePath: string, fallback: WorkbenchModeId): WorkbenchModeId {
	let candidate: unknown;
	try {
		const document = parseJsonc(readFileSync(configurationFilePath, 'utf8'), 'settings');
		candidate = readConfigurationValue(document, WorkbenchModeConfigurationKey);
	} catch {
		return fallback;
	}
	return WorkbenchModeRegistry.isModeId(candidate) ? candidate : fallback;
}

function readConfigurationValue(document: unknown, key: string): unknown {
	if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
	return (document as Readonly<Record<string, unknown>>)[key];
}
