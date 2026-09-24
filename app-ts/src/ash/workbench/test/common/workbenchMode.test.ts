import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resolveWorkbenchModeIdFromUrl, WorkbenchModeId, WorkbenchModeRegistry, withWorkbenchModeId } from '../../common/workbenchMode.js';

test('Workbench mode registry is the complete owner of built-in definitions', () => {
	assert.equal(WorkbenchModeRegistry.resolveModeId(undefined), WorkbenchModeId.Code);
	assert.equal(WorkbenchModeRegistry.resolveModeId(''), WorkbenchModeId.Code);
	assert.deepEqual(WorkbenchModeRegistry.modeIds, [WorkbenchModeId.Code, WorkbenchModeId.Academic]);
	assert.deepEqual(WorkbenchModeRegistry.definitions.map(({ id, label, storageNamespace }) => ({ id, label, storageNamespace })), [
		{ id: WorkbenchModeId.Code, label: 'Code', storageNamespace: 'code' },
		{ id: WorkbenchModeId.Academic, label: 'Academic', storageNamespace: 'academic' },
	]);
	assert.equal(WorkbenchModeRegistry.get(WorkbenchModeId.Code).dedicatedSessions?.rendererEntry, 'sessions-code');
	assert.equal(WorkbenchModeRegistry.get(WorkbenchModeId.Academic).dedicatedSessions, undefined);
});

test('Workbench mode URLs override the fallback without changing the renderer entry', () => {
	const codeUrl = 'file:///renderer/workbench/workbench.html';
	const academicUrl = withWorkbenchModeId(codeUrl, WorkbenchModeId.Academic);
	assert.equal(resolveWorkbenchModeIdFromUrl(codeUrl, WorkbenchModeId.Code), WorkbenchModeId.Code);
	assert.equal(resolveWorkbenchModeIdFromUrl(academicUrl, WorkbenchModeId.Code), WorkbenchModeId.Academic);
	assert.equal(new URL(academicUrl).pathname, new URL(codeUrl).pathname);
});

test('Workbench mode registry rejects unknown ids', () => {
	assert.throws(() => WorkbenchModeRegistry.resolveModeId('enterprise'), /Unknown Ash Workbench mode 'enterprise'/);
});
