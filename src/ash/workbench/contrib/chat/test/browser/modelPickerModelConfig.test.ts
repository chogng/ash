import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortOptions, getModelConfigSummary } from '../../browser/widget/input/modelPicker/modelPickerModelConfig.js';
import { getFastModelVariant, modelPickerAccelerationOptions } from '../../browser/widget/input/modelPicker/modelPickerVariants.js';
import { applyModelReasoningEffort } from '../../browser/widget/input/chatModelConfigurationLogic.js';

const entry: ModelCatalogEntry = {
	model: { provider: 'example', model: 'thinking' }, displayName: 'Thinking', longContext: null,
	defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium' }, { effort: 'high' }]
};

test('The picker shows the model default until an effort is selected', () => {
	const options = modelPickerEffortOptions(entry, undefined);
	assert.deepEqual(options.map(({ effort, checked }) => ({ effort, checked })), [
		{ effort: 'medium', checked: true }, { effort: 'high', checked: false },
	]);
	assert.deepEqual(modelPickerEffortOptions(entry, 'high').filter(option => option.checked).map(option => option.effort), ['high']);
});

test('An unsupported effort falls back to the first supported declaration', () => {
	const model = { ...entry, effectiveReasoningEffort: 'high' } satisfies ModelCatalogEntry;
	assert.equal(getModelConfigSummary(model, 'low'), 'High');
	assert.equal(getModelConfigSummary({ ...model, effectiveReasoningEffort: 'low' }, 'max'), 'Medium');
	const stale = { ...model, supportedReasoningEfforts: [{ effort: 'low' }] } satisfies ModelCatalogEntry;
	assert.ok(modelPickerEffortOptions(stale, 'max').every(option => !option.checked));
	assert.equal(getModelConfigSummary(stale, 'max'), 'Model default');
	assert.equal(getModelConfigSummary({ ...model, supportedReasoningEfforts: [] }, 'max'), '');
});

test('Effort labels use the active Chinese NLS catalog', () => {
	setNlsMessages('zh-CN', { ash: { 'chat.modelPicker.effortMedium': '中', 'chat.modelPicker.effortHigh': '高' } });
	try {
		assert.deepEqual(modelPickerEffortOptions(entry, undefined).map(option => option.label), ['中', '高']);
		assert.equal(getModelConfigSummary(entry, undefined), '中');
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
	assert.equal(getFastModelVariant(accelerated), undefined);
	assert.equal(getFastModelVariant({ ...accelerated, accelerationOptions: accelerated.accelerationOptions?.slice(0, 1) })?.id, 'priority');
});

test('An effective Ultra override stays selected until an explicit effort change', async () => {
	const ultra = { ...entry, reasoningEffortOverride: 'high' } satisfies ModelCatalogEntry;
	assert.equal(getModelConfigSummary(ultra, 'medium'), 'High');
	const calls: string[] = [];
	let current = true;
	const disableUltra = async () => { calls.push('disable Ultra'); };
	const apply = async () => { calls.push('save effort'); };
	await applyModelReasoningEffort('high', 'high', () => current, disableUltra, apply);
	assert.deepEqual(calls, []);
	await applyModelReasoningEffort('high', 'medium', () => current, disableUltra, apply);
	assert.deepEqual(calls, ['disable Ultra', 'save effort']);
	calls.length = 0;
	await applyModelReasoningEffort('high', 'medium', () => current, async () => {
		await disableUltra();
		current = false;
	}, apply);
	assert.deepEqual(calls, ['disable Ultra']);
});
