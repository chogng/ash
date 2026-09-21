import assert from 'node:assert/strict';
import { test } from 'mocha';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../common/model/textModel.js';
import { LanguageFeatureDebounceService } from '../../../common/services/languageFeatureDebounce.js';

test('feature delays learn within bounds and remain isolated by model, registry, configuration and host', () => {
	const service = new LanguageFeatureDebounceService();
	const registry = new LanguageFeatureRegistry<object>();
	using registration = registry.register('*', {});
	using model = new TextModel('one');
	using otherModel = new TextModel('two');
	const timing = service.for(registry, 'Completion', { min: 50, max: 500 });
	assert.equal(timing.default(), 50);
	assert.equal(timing.get(model), 50);
	assert.equal(timing.update(model, 800), 500);
	assert.equal(timing.update(model, 100), 300);
	assert.equal(timing.get(model), 300);
	assert.equal(timing.get(otherModel), 50);
	assert.equal(service.for(registry, 'Another label', { min: 50, max: 500 }), timing);
	assert.equal(service.for(registry, 'Completion', { min: 50, max: 500, salt: 'other' }).get(model), 50);
	assert.equal(service.for(registry, 'Completion', { min: 10, max: 20 }).update(model, 0), 10);
	assert.equal(service.for(new LanguageFeatureRegistry(), 'Completion').get(model), 50);
	assert.equal(new LanguageFeatureDebounceService().for(registry, 'Completion').get(model), 50);
});

test('provider replacement, language changes and disposal invalidate model timings', () => {
	const registry = new LanguageFeatureRegistry<object>();
	using first = registry.register('*', {});
	using model = new TextModel('one');
	const timing = new LanguageFeatureDebounceService().for(registry, 'Completion');
	timing.update(model, 300);
	using unrelated = registry.register('typescript', {});
	assert.equal(timing.get(model), 300);
	using replacement = registry.register('*', {});
	assert.equal(timing.get(model), 50);
	timing.update(model, 400);
	first.dispose();
	assert.equal(timing.get(model), 50);
	timing.update(model, 300);
	model.setLanguage('typescript');
	assert.equal(timing.get(model), 50);
	timing.update(model, 300);
	model.dispose();
	assert.equal(timing.get(model), 50);
	assert.equal(timing.update(model, 300), 50);
});

test('invalid delay bounds and samples fail without corrupting learned timing', () => {
	const service = new LanguageFeatureDebounceService();
	const registry = new LanguageFeatureRegistry<object>();
	using model = new TextModel('one');
	for (const config of [{ min: -1 }, { max: Infinity }, { min: 100, max: 50 }]) {
		assert.throws(() => service.for(registry, 'Completion', config), RangeError);
	}
	const timing = service.for(registry, 'Completion');
	timing.update(model, 200);
	for (const sample of [-1, NaN, Infinity]) {
		assert.throws(() => timing.update(model, sample), RangeError);
	}
	assert.equal(timing.get(model), 200);
});
