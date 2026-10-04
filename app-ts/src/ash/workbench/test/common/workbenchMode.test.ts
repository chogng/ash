import assert from 'node:assert/strict';
import { test } from 'mocha';
import { migrateAcademicWorkbenchSettings, migrateAcademicWorkbenchUrl } from '../../common/workbenchModeMigration.js';
import { resolveWorkbenchModeIdFromUrl, WorkbenchModeId, WorkbenchModeRegistry, withWorkbenchModeId } from '../../common/workbenchMode.js';

test('Workbench mode registry is the complete owner of built-in definitions', () => {
	assert.equal(WorkbenchModeRegistry.resolveModeId(undefined), WorkbenchModeId.Code);
	assert.equal(WorkbenchModeRegistry.resolveModeId(''), WorkbenchModeId.Code);
	assert.deepEqual(WorkbenchModeRegistry.modeIds, [WorkbenchModeId.Code]);
	assert.deepEqual(WorkbenchModeRegistry.definitions.map(({ id, label, storageNamespace }) => ({ id, label, storageNamespace })), [
		{ id: WorkbenchModeId.Code, label: 'Code', storageNamespace: 'code' },
	]);
	assert.equal(WorkbenchModeRegistry.get(WorkbenchModeId.Code).dedicatedSessions?.rendererEntry, 'sessions-code');
});

test('Workbench mode URLs override the fallback without changing the renderer entry', () => {
	const codeUrl = 'file:///renderer/workbench/workbench.html';
	const selectedUrl = withWorkbenchModeId(codeUrl, WorkbenchModeId.Code);
	assert.equal(resolveWorkbenchModeIdFromUrl(codeUrl, WorkbenchModeId.Code), WorkbenchModeId.Code);
	assert.equal(resolveWorkbenchModeIdFromUrl(selectedUrl, WorkbenchModeId.Code), WorkbenchModeId.Code);
	assert.equal(new URL(selectedUrl).pathname, new URL(codeUrl).pathname);
});

test('Workbench mode registry rejects unknown ids', () => {
	assert.throws(() => WorkbenchModeRegistry.resolveModeId('enterprise'), /Unknown Ash Workbench mode 'enterprise'/);
	assert.throws(() => WorkbenchModeRegistry.resolveModeId('academic'), /Unknown Ash Workbench mode/);
});

test('retired Academic settings and links migrate once while retaining unrelated data', () => {
	const source = '{\n// mode preference\n"workbench.mode": "academic", "editor.fontSize": 18,\n}';
	const migrated = migrateAcademicWorkbenchSettings(source)!;
	assert.match(migrated, /mode preference/u);
	assert.match(migrated, /"editor.fontSize": 18/u);
	assert.match(migrated, /"workbench.mode": "code"/u);
	assert.equal(migrateAcademicWorkbenchSettings(migrated), undefined);
	const url = 'https://ash.test/workbench.html?ash-workbench-mode=academic&folder=research';
	const target = migrateAcademicWorkbenchUrl(url);
	assert.equal(new URL(target).searchParams.get('folder'), 'research');
	assert.equal(resolveWorkbenchModeIdFromUrl(target, WorkbenchModeId.Code), WorkbenchModeId.Code);
	assert.equal(migrateAcademicWorkbenchUrl(target), target);
});
