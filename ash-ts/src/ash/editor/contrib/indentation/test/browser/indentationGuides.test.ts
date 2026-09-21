import assert from "node:assert/strict";
import { test } from "mocha";
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';

test('Indentation guides use visual tab stops and the model indentation unit', () => {
	using model = new TextModel('        value\n  \t  value\n  value  ');
	model.updateOptions({ tabSize: 4, indentSize: 2 });
	assert.deepEqual(model.guides.getLinesIndentGuides(1, 3), [4, 3, 1]);
	model.updateOptions({ indentSize: 4 });
	assert.deepEqual(model.guides.getLinesIndentGuides(1, 3), [2, 2, 1]);
});

test('Blank-line guides follow the language off-side rule', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('root\n    child\n\nroot', { languageId: 'guide-test', languageConfigurationService: configurations });
	assert.deepEqual(model.guides.getLinesIndentGuides(1, 4), [0, 1, 1, 0]);
	using registration = configurations.register('guide-test', { folding: { offSide: true } });
	assert.deepEqual(model.guides.getLinesIndentGuides(1, 4), [0, 1, 0, 0]);
});
