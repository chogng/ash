import { StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';

test('status bar entries are grouped and ordered by alignment', () => {
	using service = new StatusbarService();
	using lowPriority = service.addEntry(
		{ text: 'Low' },
		{
			id: 'test.low',
			alignment: StatusbarAlignment.Left,
			priority: 1,
		},
	);
	using right = service.addEntry(
		{ text: 'Right' },
		{
			id: 'test.right',
			alignment: StatusbarAlignment.Right,
		},
	);
	using highPriority = service.addEntry(
		{ text: 'High' },
		{
			id: 'test.high',
			alignment: StatusbarAlignment.Left,
			priority: 10,
		},
	);

	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Left).map(({ id }) => id),
		['test.high', 'test.low'],
	);
	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Right).map(({ id }) => id),
		['test.right'],
	);
});

test('status bar entry accessors update and remove their entry', () => {
	using service = new StatusbarService();
	let changes = 0;
	using listener = service.onDidChangeEntries(() => {
		changes += 1;
	});
	const entry = service.addEntry(
		{ text: 'Connecting' },
		{
			id: 'test.connection',
			alignment: StatusbarAlignment.Left,
		},
	);

	entry.update({
		text: 'Connected',
		tooltip: 'The app server is connected',
	});
	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Left)[0]?.entry,
		{
			text: 'Connected',
			tooltip: 'The app server is connected',
		},
	);

	entry.dispose();
	assert.deepEqual(service.getEntries(StatusbarAlignment.Left), []);
	assert.equal(changes, 3);
});

test('status bar entry ids are unique while registered', () => {
	using service = new StatusbarService();
	using entry = service.addEntry(
		{ text: 'First' },
		{
			id: 'test.unique',
			alignment: StatusbarAlignment.Left,
		},
	);

	assert.throws(
		() => service.addEntry(
			{ text: 'Duplicate' },
			{
				id: 'test.unique',
				alignment: StatusbarAlignment.Right,
			},
		),
		/already exists/,
	);
});


test('auxiliary status bars observe shared entries through their owner and retain local editor entries', () => {
	using main = new StatusbarService();
	using auxiliary = new StatusbarService(main);
	using shared = main.addEntry({ text: 'Connected', showInAllWindows: true }, { id: 'remote', alignment: StatusbarAlignment.Left });
	using mainOnly = main.addEntry({ text: 'Main only' }, { id: 'main', alignment: StatusbarAlignment.Left });
	using editor = auxiliary.addEntry({ text: 'Ln 2' }, { id: 'editor', alignment: StatusbarAlignment.Right });
	assert.deepEqual(auxiliary.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ['Connected']);
	shared.update({ text: 'Disconnected', showInAllWindows: true });
	assert.deepEqual(auxiliary.getEntries(StatusbarAlignment.Left).map(item => item.entry.text), ['Disconnected']);
	shared.dispose();
	assert.deepEqual(auxiliary.getEntries(StatusbarAlignment.Left), []);
	assert.deepEqual(auxiliary.getEntries(StatusbarAlignment.Right).map(item => item.entry.text), ['Ln 2']);
});


test('status bar style leases respect priority and restore the prior owner on release', () => {
	using service = new StatusbarService();
	const debug = service.overrideStyle({ priority: 10, background: 'statusBar.debuggingBackground' });
	const urgent = service.overrideStyle({ priority: 1, background: 'urgent' });
	assert.equal(service.style?.background, 'urgent');
	urgent.dispose();
	assert.equal(service.style?.background, 'statusBar.debuggingBackground');
	debug.dispose();
	assert.equal(service.style, undefined);
});
