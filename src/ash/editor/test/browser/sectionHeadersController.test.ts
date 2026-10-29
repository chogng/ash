import { registerTestCodeEditorFeatures } from '../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import './testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event, Emitter } from '../../../base/common/event.js';
import type { ICodeEditor } from '../../browser/editorBrowser.js';
import type { View } from '../../browser/view.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';
import { SectionHeadersController } from '../../contrib/sectionHeaders/browser/sectionHeadersController.js';
import { createTestLanguageConfigurationService } from '../common/modes/testLanguageConfigurationService.js';

test('section headers scan only visible chunks and reuse text candidates on token and layout events', () => {
	const lines = Array.from({ length: 100_000 }, () => 'const value = 1;');
	lines[95_004] = '// #region -- Visible --';
	using model = new TextModel(lines.join('\n'));
	model.setLanguage('javascript');
	using configurations = createTestLanguageConfigurationService();
	using layout = new Emitter<void>();
	const root = document.createElement('div');
	for (let index = 95_000; index < 95_010; index++) {
		const line = document.createElement('div');
		line.className = 'view-line';
		line.dataset.logicalLineIndex = String(index);
		root.append(line);
	}
	const view = { textModel: model, domNode: { domNode: root }, onDidChangeLayout: layout.event } as unknown as View;
	const editor = {
		getOption: () => ({ enabled: false }),
		onDidChangeConfiguration: Event.None,
		createDecorationsCollection: () => ({ clear() {}, set() {} }),
	} as unknown as ICodeEditor;
	const getLineContent = model.getLineContent;
	let reads = 0;
	model.getLineContent = line => {
		reads++;
		return getLineContent.call(model, line);
	};
	try {
		using controller = new SectionHeadersController(view, model, editor, configurations, () => ({
			findRegionSectionHeaders: true,
			findMarkSectionHeaders: false,
			markSectionHeaderRegex: '',
		}));
		const header = root.children[4]!;
		assert.equal(header.getAttribute('data-section-header'), 'true');
		assert.ok(reads < 400, `${reads} line reads for a ten-line viewport`);
		reads = 0;
		layout.fire();
		model.tokenization.setSemanticTokens(null, false);
		layout.fire();
		assert.equal(reads, 0, 'unchanged text is not scanned again for token/layout notifications');
		model.applyOperations([
			{ range: new Range(95_005, 1, 95_005, model.getLineMaxColumn(95_005)), text: '// ordinary comment' },
		]);
		assert.equal(
			header.hasAttribute('data-section-header'),
			false,
			'content edits invalidate the visible candidates',
		);
		assert.ok(reads < 500);
		reads = 0;
		root.children[0]!.setAttribute('data-logical-line-index', '0');
		layout.fire();
		assert.equal(root.children[0]!.classList.contains('section-header'), false);
		assert.ok(reads < 500, 'folded gaps are not scanned');
	} finally {
		model.getLineContent = getLineContent;
	}
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
