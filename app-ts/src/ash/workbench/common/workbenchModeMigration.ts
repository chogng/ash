import { parseJsonc } from '../../base/common/jsonc.js';
import { applyEdits, setProperty } from '../../base/common/jsonEdit.js';
import { WorkbenchModeConfigurationKey, WorkbenchModeId, WorkbenchModeQueryParameter } from './workbenchMode.js';

/** Migrates the retired mode in its persisted source; ordinary mode validation remains strict. */
export function migrateAcademicWorkbenchSettings(source: string): string | undefined {
	const values = parseJsonc(source, 'settings') as Record<string, unknown>;
	if (values[WorkbenchModeConfigurationKey] !== 'academic') { return undefined; }
	return applyEdits(source, setProperty(source, [WorkbenchModeConfigurationKey], WorkbenchModeId.Code));
}

export function migrateAcademicWorkbenchUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.searchParams.get(WorkbenchModeQueryParameter) !== 'academic') { return url; }
	parsed.searchParams.set(WorkbenchModeQueryParameter, WorkbenchModeId.Code);
	return parsed.href;
}
