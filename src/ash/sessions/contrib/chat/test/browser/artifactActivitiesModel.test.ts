import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { Automation, AutomationRun, IAutomationBackendService } from '../../../../../platform/automations/common/automation.js';
import { ArtifactActivitiesModel } from '../../browser/artifactActivitiesModel.js';

test('Artifact activities drop an older plan response and only load while expanded', async () => {
	using changed = new Emitter<void>();
	const old = new DeferredPromise<readonly AutomationRun[]>();
	const current = new DeferredPromise<readonly AutomationRun[]>();
	const reads: string[] = [];
	using model = new ArtifactActivitiesModel({
		onDidChange: changed.event,
		runs(id: string) {
			reads.push(id);
			return id === 'old' ? old.p : current.p;
		},
	} as IAutomationBackendService);
	model.setPlan({ id: 'old', revision: 1 } as Automation);
	assert.deepEqual(reads, []);
	model.setExpanded(true);
	model.setPlan({ id: 'current', revision: 1 } as Automation);
	const run = { id: 'current-run' } as AutomationRun;
	await current.complete([run]);
	await old.complete([{ id: 'old-run' } as AutomationRun]);
	assert.deepEqual(model.state.get(), { kind: 'ready', runs: [run] });
	model.setExpanded(false);
	changed.fire();
	assert.deepEqual(reads, ['old', 'current']);
	assert.deepEqual(model.state.get(), { kind: 'ready', runs: [] });
});
