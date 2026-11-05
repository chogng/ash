import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortOptions, modelPickerAccelerationOptions, getModelConfigSummary } from '../../browser/widget/input/modelPicker/modelPickerModelConfig.js';

const entry: ModelCatalogEntry = {
	model: { provider: 'example', model: 'thinking' }, displayName: 'Thinking', longContext: null,
	defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }]
};

test('The picker lists only supported levels and leaves an unset preference unchecked', () => {
	const options = modelPickerEffortOptions(entry, undefined);
	assert.deepEqual(options.map(({ effort, checked }) => ({ effort, checked })), [
		{ effort: 'medium', checked: false }, { effort: 'high', checked: false },
	]);
	assert.deepEqual(modelPickerEffortOptions(entry, 'medium').filter(option => option.checked).map(option => option.effort), ['medium']);
});

test('An unsupported preference is omitted from the summary and left unchecked', () => {
	const model = { ...entry, supportedReasoningEfforts: [{ effort: 'high' }] } satisfies ModelCatalogEntry;
	assert.ok(modelPickerEffortOptions(model, 'medium').every(option => !option.checked));
	assert.equal(getModelConfigSummary(model, 'medium'), '');
});

test('Effort labels use the active Chinese NLS catalog', () => {
	setNlsMessages('zh-CN', { ash: { 'chat.modelPicker.effortMedium': '中', 'chat.modelPicker.effortHigh': '高' } });
	try {
		assert.deepEqual(modelPickerEffortOptions(entry, undefined).map(option => option.label), ['中', '高']);
	} finally { resetNlsResolver(); }
});


test('Acceleration choices preserve connection IDs, clear with null and keep provider copy intact', () => {
	const accelerated: ModelCatalogEntry = {
		...entry, selectedAcceleration: 'speed:fast', accelerationOptions: [
			{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' },
			{ id: 'speed:fast', name: 'Provider quick mode', description: 'Provider-authored speed details' },
			{ id: 'model:highspeed', name: 'Highspeed model', description: 'Routes to the declared model' },
		],
	};
	const choices = modelPickerAccelerationOptions(accelerated);
	assert.deepEqual(choices.map(({ value, checked }) => ({ value, checked })), [
		{ value: null, checked: false }, { value: 'priority', checked: false },
		{ value: 'speed:fast', checked: true }, { value: 'model:highspeed', checked: false },
	]);
	assert.equal(choices[2]!.description, 'Provider-authored speed details');
	assert.equal(getModelConfigSummary(accelerated, 'high'), 'High · Provider quick mode');
	assert.equal(modelPickerAccelerationOptions({ ...accelerated, selectedAcceleration: null })[0]!.checked, true);
	assert.deepEqual(modelPickerAccelerationOptions(entry), []);
});
