import { readFileSync } from 'node:fs';
import { parseJsonc } from '../../base/common/jsonc.js';
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry, type WorkbenchModeId } from '../../workbench/common/workbenchMode.js';

/** Reads the preferred startup mode without making the full configuration service a bootstrap dependency. */
export function readPersistedWorkbenchModeId(configurationFilePath: string, fallback: WorkbenchModeId): WorkbenchModeId {
	let candidate: unknown;
	try {
		const document = JSON.parse(readFileSync(configurationFilePath, 'utf8')) as unknown;
		candidate = readConfigurationValue(document, WorkbenchModeConfigurationKey);
	} catch {
		return fallback;
	}
	return WorkbenchModeRegistry.isModeId(candidate) ? candidate : fallback;
}

function readConfigurationValue(document: unknown, key: string): unknown {
	if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
	const record = document as Readonly<Record<string, unknown>>;
	if (record.version !== 1 || typeof record.source !== 'string') return undefined;
	const fields = Object.keys(record).sort();
	if (fields.length !== 2 || fields[0] !== 'source' || fields[1] !== 'version') return undefined;
	const values = parseJsonc(record.source, 'configuration source');
	if (typeof values !== 'object' || values === null || Array.isArray(values)) return undefined;
	return (values as Readonly<Record<string, unknown>>)[key];
}
