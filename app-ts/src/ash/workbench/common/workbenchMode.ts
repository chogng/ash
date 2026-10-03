import { parseJsonc } from '../../base/common/jsonc.js';
import { applyEdits, setProperty } from '../../base/common/jsonEdit.js';

export const WorkbenchModeId = Object.freeze({
	Code: 'code',
} as const);

export type WorkbenchModeId = typeof WorkbenchModeId[keyof typeof WorkbenchModeId];

export const WorkbenchModeQueryParameter = 'ash-workbench-mode';
export const WorkbenchModeConfigurationKey = 'workbench.mode';
export const WorkbenchRendererEntry = 'workbench';

export interface DedicatedSessionsDefinition {
	readonly rendererEntry: string;
}

/** Static identity and optional surfaces owned by one built-in Workbench mode. */
export interface WorkbenchModeDefinition {
	readonly id: WorkbenchModeId;
	readonly label: string;
	readonly title: string;
	readonly storageNamespace: string;
	readonly dedicatedSessions?: DedicatedSessionsDefinition;
}

const definitions: Readonly<Record<WorkbenchModeId, WorkbenchModeDefinition>> = Object.freeze({
	[WorkbenchModeId.Code]: Object.freeze({
		id: WorkbenchModeId.Code,
		label: 'Code',
		title: 'Ash Code',
		storageNamespace: 'code',
		dedicatedSessions: Object.freeze({
			rendererEntry: 'sessions-code',
		}),
	}),
});

const modeIds = Object.freeze(Object.keys(definitions) as WorkbenchModeId[]);
const modeDefinitions = Object.freeze(modeIds.map(modeId => definitions[modeId]));
const defaultModeId: WorkbenchModeId = WorkbenchModeId.Code;

/** Canonical catalog and boundary validation for every built-in Workbench mode. */
export const WorkbenchModeRegistry = Object.freeze({
	defaultModeId,
	modeIds,
	definitions: modeDefinitions,
	get(modeId: WorkbenchModeId): WorkbenchModeDefinition {
		return definitions[modeId];
	},
	isModeId(value: unknown): value is WorkbenchModeId {
		return typeof value === 'string' && Object.hasOwn(definitions, value);
	},
	resolveModeId(value: string | undefined): WorkbenchModeId {
		if (value === undefined || value.length === 0) return defaultModeId;
		if (this.isModeId(value)) return value;
		throw new TypeError(`Unknown Ash Workbench mode '${value}'. Expected ${modeIds.join(', ')}`);
	},
});

export function resolveWorkbenchModeIdFromUrl(url: string, fallback: WorkbenchModeId): WorkbenchModeId {
	const candidate = new URL(url).searchParams.get(WorkbenchModeQueryParameter);
	return candidate === null ? fallback : WorkbenchModeRegistry.resolveModeId(candidate);
}

export function withWorkbenchModeId(url: string, modeId: WorkbenchModeId): string {
	const result = new URL(url);
	result.searchParams.set(WorkbenchModeQueryParameter, modeId);
	return result.href;
}

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
