import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortOptions, modelPickerAccelerationOptions, getModelConfigSummary } from '../../browser/widget/input/modelPicker/modelPickerModelConfig.js';

const entry: ModelCatalogEntry = {
	model: { provider: 'example', model: 'thinking' }, displayName: 'Thinking', longContext: null,
	defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }]
};

test('Choosing the model default emits an unset override and exactly one checked effort', () => {
	const options = modelPickerEffortOptions(entry, undefined);
	assert.deepEqual(options.map(({ value, checked }) => ({ value, checked })), [{ value: undefined, checked: true }, { value: 'high', checked: false }]);
	assert.deepEqual(modelPickerEffortOptions(entry, 'high').filter(option => option.checked).map(option => option.value), ['high']);
});

test('A catalog default no longer present among supported efforts retains an explicit Default choice', () => {
	const options = modelPickerEffortOptions({ ...entry, supportedReasoningEfforts: [{ effort: 'high' }] }, undefined);
	assert.equal(options[0].value, undefined);
	assert.equal(options[0].checked, true);
	assert.equal(options.filter(option => option.checked).length, 1);
});

test('Default effort labels use the active Chinese NLS catalog', () => {
	setNlsMessages('zh-CN', { ash: { 'chat.modelPicker.defaultEffort': '默认', 'chat.modelPicker.effortHigh': '高' } });
	try {
		assert.deepEqual(modelPickerEffortOptions({ ...entry, defaultReasoningEffort: undefined, supportedReasoningEfforts: [{ effort: 'high' }] }, undefined).map(option => option.label), ['默认', '高']);
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
