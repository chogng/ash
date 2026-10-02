import './media/testingEditorContribution.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MouseTargetType, type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { GlyphMarginLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { TextDecorationCollection } from '../../../../editor/common/model/decorationCollection.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITestingService, type ITestCase } from '../../../services/testing/common/testingService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { testStateLabel } from './testingLabels.js';

/** Test controls use their own gutter lane, separate from breakpoints. */
export class TestingEditorContribution extends Disposable {
	private readonly decorations: TextDecorationCollection<ITestCase>;
	private invalidated = false;
	private catalog: readonly ITestCase[];

	constructor(editor: Pick<ICodeEditor, 'onMouseDown'>, model: TextModel,
		@ITestingService private readonly testing: ITestingService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.decorations = this._register(new TextDecorationCollection<ITestCase>(model));
		this.catalog = testing.tests;
		this.update();
		this._register(model.onDidChangeContent(() => {
			// Disk discovery cannot identify newly edited lines until the file is saved
			// and rediscovered. Remove stale controls rather than running a wrong case.
			this.invalidated = true;
			this.update();
		}));
		this._register(testing.onDidChangeTests(() => {
			if (this.catalog !== testing.tests) { this.catalog = testing.tests; this.invalidated = false; }
			this.update();
		}));
		this._register(editor.onMouseDown(event => {
			const target = event.target;
			if (target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || target.detail.glyphMarginLane !== GlyphMarginLane.Right || !target.position) { return; }
			const tests = this.decorations.decorations.filter(decoration => decoration.range.startLineNumber === target.position!.lineNumber);
			if (tests.length === 0 || testing.isRunningTests || testing.isDiscovering) { return; }
			event.event.preventDefault(); event.event.stopPropagation();
			void testing.runTests(tests.map(test => test.metadata.key)).catch(error => this.report(error));
		}));
		if (model.getLanguageId() === 'rust' && testing.tests.length === 0 && !testing.isDiscovering) {
			void testing.refreshTests().catch(error => this.report(error));
		}
	}

	private update(): void {
		const model = this.decorations.textModel;
		const dirty = this.copies.get(model.uri).some(copy => copy.isDirty);
		const tests = this.invalidated || dirty ? [] : this.testing.tests.filter(test => test.resource.toString() === model.uri.toString() && test.line <= model.lineCount);
		this.decorations.replaceAll(tests.map(test => ({
			range: Range.fromPositions(new Position(test.line, 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			metadata: test,
			options: {
				description: 'testing-run-test',
				glyphMarginClassName: 'ash-testing-gutter',
				glyphMargin: { position: GlyphMarginLane.Right, persistLane: true },
				glyphMarginHoverMessage: { value: localize('testing.runGutter', 'Run {0} · {1}', test.name, testStateLabel(this.testing.testResults.find(result => result.key === test.key)?.state)) },
				zIndex: 10,
			},
		})));
	}

	private report(error: unknown): void {
		this.notifications.error(error instanceof Error ? error.message : localize('testing.operationFailed', 'Test operation failed.'));
	}
}
