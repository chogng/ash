import { StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ISCMViewService, type ISCMProvider, type ISCMStatusBarCommand } from '../../common/scm.js';
import { ScmStatusContribution } from '../../browser/activity.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';

test('SCM status renders provider commands on their declared side and follows updates', async () => {
	using fixture = createFixture();
	using cursor = fixture.statusbar.addEntry({ text: 'Ln 1, Col 1' }, { id: 'editor.cursor', alignment: StatusbarAlignment.Right, priority: 40 });
	let invoked = 0;
	const blame: ISCMStatusBarCommand = {
		id: 'test.blame',
		text: 'Author (1 day ago)',
		ariaLabel: 'Line author',
		tooltip: 'Open commit',
		alignment: 'right',
		priority: 30,
		run: () => invoked++,
	};
	fixture.provider.statusBarCommands = [
		{
			id: 'test.branch',
			text: 'main',
			ariaLabel: 'Branch main',
			tooltip: 'Switch branch',
			priority: 900,
			compactGroup: 'test',
		},
		blame,
	];
	fixture.changed.fire();
	const entries = () => fixture.statusbar.getEntries(StatusbarAlignment.Left);
	assert.deepEqual(
		entries().map(item => [item.id, item.entry.text, item.compactGroup]),
		[['test.branch', 'main', 'test']],
	);
	const rightEntries = () => fixture.statusbar.getEntries(StatusbarAlignment.Right);
	assert.deepEqual(
		rightEntries().map(item => item.id),
		['editor.cursor', 'test.blame'],
	);
	await rightEntries()[1].entry.run?.();
	assert.equal(invoked, 1);
	fixture.provider.statusBarCommands = [
		{ id: 'test.branch', text: 'working', ariaLabel: 'Working', tooltip: 'Working', priority: 900 },
		{ ...blame, text: 'Updated author', run: undefined },
	];
	fixture.changed.fire();
	assert.equal(entries()[0].entry.text, 'working');
	assert.equal(entries()[0].entry.run, undefined);
	assert.equal(rightEntries()[1].entry.text, 'Updated author');
	assert.equal(rightEntries()[1].entry.run, undefined);
	fixture.provider.statusBarCommands = [{ ...blame, alignment: 'left' }];
	fixture.changed.fire();
	assert.deepEqual(
		entries().map(item => item.id),
		['test.blame'],
	);
	assert.deepEqual(
		rightEntries().map(item => item.id),
		['editor.cursor'],
	);
	fixture.viewService.selectRepository(undefined);
	assert.deepEqual(entries(), []);
	assert.deepEqual(
		rightEntries().map(item => item.id),
		['editor.cursor'],
	);
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
	const provider: ISCMProvider & { statusBarCommands: ISCMStatusBarCommand[] } = {
		id: 'test',
		providerId: 'test',
		label: 'Test',
		groups: [],
		onDidChangeResources: changed.event,
		input: {
			value: '',
			placeholder: '',
			enabled: false,
			canAccept: false,
			buttonLabel: '',
			buttonTooltip: '',
			accept: async () => undefined,
		},
		activeRepositoryName: undefined,
		statusBarCommands: [],
		statusMessage: '',
		isBusy: false,
		refresh: async () => {},
		activate: async () => {},
	};
	const registration = resources.add(scmService.registerSCMProvider(provider));
	const container = resources.add(new InstantiationService());
	container.registerInstance(ISCMViewService, viewService);
	container.registerInstance(IStatusbarService, statusbar);
	resources.add(container.createInstance(ScmStatusContribution));
	return Object.assign(resources, { provider, changed, registration, viewService, statusbar });
}
