import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ConfigurationModel } from '../../common/configurationModels.js';
import { NullLoggerService } from '../../../log/common/log.js';

test('configuration model combines structured values and replaces arrays without changing its inputs', () => {
	const contents = {
		editor: { options: Object.freeze({ colors: { foreground: 'gray', background: 'black' }, rulers: [80] }) },
	};
	const log = new NullLoggerService();
	const defaults = new ConfigurationModel(contents, ['editor.options'], [], undefined, log);
	const user = new ConfigurationModel({ editor: { options: { colors: { foreground: 'white' }, rulers: [100] } } }, ['editor.options'], [], undefined, log);
	const combined = defaults.merge(user);

	contents.editor.options.rulers.push(120);
	assert.deepEqual(combined.getValue('editor.options'), {
		colors: { foreground: 'white', background: 'black' },
		rulers: [100],
	});
	assert.deepEqual(defaults.getValue('editor.options'), {
		colors: { foreground: 'gray', background: 'black' },
		rulers: [80],
	});
	assert.deepEqual(user.getValue('editor.options'), { colors: { foreground: 'white' }, rulers: [100] });
	assert.throws(() => combined.getValue<number[]>('editor.options.rulers')!.push(120), TypeError);
});

test('configuration model gives a single language priority over combined blocks and keeps other languages separate', () => {
	const log = new NullLoggerService();
	const model = new ConfigurationModel(
		{ editor: { tabSize: 4 } },
		['editor.tabSize'],
		[
			{ identifiers: ['typescript'], keys: ['editor.tabSize'], contents: { editor: { tabSize: 2 } } },
			{
				identifiers: ['typescript', 'javascript'],
				keys: ['editor.tabSize', 'editor.insertSpaces'],
				contents: { editor: { tabSize: 6, insertSpaces: true } },
			},
		],
		undefined,
		log,
	);

	assert.deepEqual(model.override('typescript').getValue('editor'), { tabSize: 2, insertSpaces: true });
	assert.deepEqual(model.override('javascript').getValue('editor'), { tabSize: 6, insertSpaces: true });
	assert.deepEqual(model.override('python').getValue('editor'), { tabSize: 4 });
	assert.equal(model.getOverrideValue('editor.tabSize', 'typescript'), 2);
	assert.equal(model.getOverrideValue('editor.tabSize', 'python'), undefined);
	assert.deepEqual(model.contents, { editor: { tabSize: 4 } });

	const data = model.toJSON();
	data.keys.length = 0;
	data.overrides[0]!.identifiers.length = 0;
	data.overrides.length = 0;
	assert.deepEqual(model.keys, ['editor.tabSize']);
	assert.equal(model.override('typescript').getValue('editor.tabSize'), 2);
});

test('configuration model merges matching language groups across layers without losing unrelated overrides', () => {
	const log = new NullLoggerService();
	const defaults = new ConfigurationModel(
		{},
		[],
		[
			{
				identifiers: ['typescript', 'javascript'],
				keys: ['editor.options'],
				contents: { editor: { options: { colors: { foreground: 'gray' }, rulers: [80] } } },
			},
			{ identifiers: ['python'], keys: ['editor.tabSize'], contents: { editor: { tabSize: 4 } } },
		],
		undefined,
		log,
	);
	const user = new ConfigurationModel(
		{},
		[],
		[
			{
				identifiers: ['typescript', 'javascript'],
				keys: ['editor.options'],
				contents: { editor: { options: { colors: { foreground: 'white' } } } },
			},
		],
		undefined,
		log,
	);
	const merged = defaults.merge(user);
	assert.deepEqual(merged.override('typescript').getValue('editor.options'), {
		colors: { foreground: 'white' },
		rulers: [80],
	});
	assert.deepEqual(merged.override('javascript').getValue('editor.options'), {
		colors: { foreground: 'white' },
		rulers: [80],
	});
	assert.equal(merged.override('python').getValue('editor.tabSize'), 4);
	assert.deepEqual(defaults.override('typescript').getValue('editor.options'), {
		colors: { foreground: 'gray' },
		rulers: [80],
	});
	assert.deepEqual(user.override('typescript').getValue('editor.options'), { colors: { foreground: 'white' } });
});
