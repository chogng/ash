import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ISCMViewService, type ISCMProvider, type ISCMStatusBarCommand } from '../../common/scm.js';
import { ScmStatusContribution } from '../../browser/activity.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { IStatusbarService, StatusbarAlignment, StatusbarService } from '../../../../services/statusbar/browser/statusbar.js';

test('SCM status renders and invokes the selected provider commands and follows updates', async () => {
	using fixture = createFixture();
	let invoked = 0;
	fixture.provider.statusBarCommands = [{ id: 'test.branch', text: 'main', ariaLabel: 'Branch main', tooltip: 'Switch branch', priority: 900, compactGroup: 'test', run: () => invoked++ }];
	fixture.changed.fire();
	const entries = () => fixture.statusbar.getEntries(StatusbarAlignment.Left);
	assert.deepEqual(entries().map(item => [item.id, item.entry.text, item.compactGroup]), [['test.branch', 'main', 'test']]);
	await entries()[0].entry.run?.();
	assert.equal(invoked, 1);
	fixture.provider.statusBarCommands = [{ id: 'test.branch', text: 'working', ariaLabel: 'Working', tooltip: 'Working', priority: 900 }];
	fixture.changed.fire();
	assert.equal(entries()[0].entry.text, 'working');
	assert.equal(entries()[0].entry.run, undefined);
	fixture.viewService.selectRepository(undefined);
	assert.deepEqual(entries(), []);
});

test('SCM status retires entries and listeners when its repository is removed', () => {
	using fixture = createFixture();
	fixture.provider.statusBarCommands = [{ id: 'test.branch', text: 'main', ariaLabel: 'Branch main', tooltip: 'Switch branch', priority: 900 }];
	fixture.changed.fire();
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left).length, 1);
	fixture.registration.dispose();
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
	fixture.changed.fire();
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
});

function createFixture() {
	const resources = new DisposableStore();
	const changed = resources.add(new Emitter<void>());
	const scmService = resources.add(new SCMService());
	const viewService = resources.add(new SCMViewService(scmService));
	const statusbar = resources.add(new StatusbarService());
	const provider: ISCMProvider & { statusBarCommands: ISCMStatusBarCommand[]; } = {
		id: 'test', providerId: 'test', label: 'Test', groups: [], onDidChangeResources: changed.event,
		input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
		activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false,
		refresh: async () => { }, activate: async () => { },
	};
	const registration = resources.add(scmService.registerSCMProvider(provider));
	const container = resources.add(new InstantiationService());
	container.registerInstance(ISCMViewService, viewService);
	container.registerInstance(IStatusbarService, statusbar);
	resources.add(container.createInstance(ScmStatusContribution));
	return Object.assign(resources, { provider, changed, registration, viewService, statusbar });
}
