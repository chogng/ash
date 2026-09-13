import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { readPersistedWorkbenchModeId } from '../../electron-main/readPersistedWorkbenchMode.js';
import { WorkbenchModeId } from '../../../workbench/common/workbenchMode.js';

test('persisted startup mode accepts only the canonical configuration source and a registered id', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-mode-'));
	const filePath = join(directory, 'configuration.json');
	try {
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
		writeFileSync(filePath, JSON.stringify({ version: 1, source: '{\n\t// startup mode\n\t"workbench.mode": "academic",\n}\n' }));
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Academic);
		writeFileSync(filePath, JSON.stringify({ version: 1, source: '{ "workbench.mode": "unknown" }' }));
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
		writeFileSync(filePath, JSON.stringify({ version: 1, values: { 'workbench.mode': 'academic' } }));
		assert.equal(readPersistedWorkbenchModeId(filePath, WorkbenchModeId.Code), WorkbenchModeId.Code);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
