import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';
import { HorizontalGuidesState } from '../../../common/textModelGuides.js';
import { TestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';

const guideOptions = { includeInactive: true, horizontalGuides: HorizontalGuidesState.Disabled, highlightActive: true };

test('Bracket guides remain available when bracket colors are disabled', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n  value\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });

	assert.deepEqual(model.getLineDecorations(1), []);
	assert.deepEqual(model.guides.getLinesBracketGuides(2, 2, null, guideOptions).map(line => line.map(guide => ({
		visibleColumn: guide.visibleColumn,
		className: guide.className,
	}))), [[{ visibleColumn: 1, className: 'stanza-editor-guide-level-1' }]]);
});

test('Bracket guide levels follow the model color pool', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n(\n[\nvalue\n]\n)\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}'], ['(', ')'], ['[', ']']] });
	const classes = () => model.guides.getLinesBracketGuides(4, 4, null, guideOptions)[0]!.map(guide => guide.className);
	assert.deepEqual(classes(), ['stanza-editor-guide-level-1', 'stanza-editor-guide-level-2', 'stanza-editor-guide-level-3']);

	model.updateOptions({ bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: true } });
	assert.deepEqual(classes(), Array(3).fill('stanza-editor-guide-level-1'));
});

test('Bracket guides use minimum indentation and refresh after edits', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('call(\n\tfirst,\n  second\n    third)', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['(', ')']] });
	const columns = () => model.guides.getLinesBracketGuides(2, 3, null, guideOptions).map(line => line.map(guide => guide.visibleColumn));
	assert.deepEqual(columns(), [[3], [3]]);

	model.applyEdits([{ range: new Range(3, 1, 3, 3), text: '    ' }]);
	assert.deepEqual(columns(), [[5], [5]]);
});

test('Bracket guides include the closing half-stroke and active pair', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('{\n  value\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}']] });
	const guides = model.guides.getLinesBracketGuides(1, 3, { lineNumber: 2, column: 3 }, { ...guideOptions, includeInactive: false });
	assert.deepEqual(guides.map(line => line.map(guide => ({
		visibleColumn: guide.visibleColumn,
		className: guide.className,
		endColumn: guide.forWrappedLinesBeforeOrAtColumn,
	}))), [
		[{ visibleColumn: 1, className: 'stanza-editor-guide-level-1 active', endColumn: -1 }],
		[{ visibleColumn: 1, className: 'stanza-editor-guide-level-1 active', endColumn: -1 }],
		[{ visibleColumn: 1, className: 'stanza-editor-guide-level-1 active', endColumn: 1 }],
	]);
});

test('Multiline bracket guide stays active inside a single-line pair', () => {
	using configurations = new TestLanguageConfigurationService();
	using model = new TextModel('function example() {\n    call();\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	using registration = configurations.register('typescript', { brackets: [['{', '}'], ['(', ')']] });
	const guides = model.guides.getLinesBracketGuides(1, 3, { lineNumber: 2, column: 10 }, guideOptions);
	assert.deepEqual(guides.map(line => line.filter(guide => !guide.horizontalLine).map(guide => guide.className)), [
		['stanza-editor-guide-level-1 active'],
		['stanza-editor-guide-level-1 active'],
		['stanza-editor-guide-level-1 active'],
	]);
});
