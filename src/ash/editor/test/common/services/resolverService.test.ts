import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ITextModelService, isResolvedTextEditorModel, type ITextEditorModel } from '../../../common/services/resolverService.js';
import type { ITextModel } from '../../../common/model.js';

test('resolver service keeps unresolved and resolved editor models distinct', () => {
	assert.equal(ITextModelService.description, 'textModelService');
	assert.equal(isResolvedTextEditorModel({ textEditorModel: null } as ITextEditorModel), false);
	assert.equal(isResolvedTextEditorModel({ textEditorModel: {} as ITextModel } as ITextEditorModel), true);
});
