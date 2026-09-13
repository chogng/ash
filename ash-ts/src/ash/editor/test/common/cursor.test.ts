import assert from "node:assert/strict";
import { test } from "mocha";
import { DisposableTracker, installDisposableTracker } from "../../../base/common/lifecycle.js";
import { CursorsController } from "../../common/cursor/cursor.js";
import { Cursor } from '../../common/cursor/oneCursor.js';
import { CursorChangeReason } from "../../common/cursorEvents.js";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { type TextModelChange } from '../../common/core/textChange.js';
import { TextModel } from "../../common/model/textModel.js";
import { ReplaceCommand, ReplaceCommandThatPreservesSelection } from '../../common/commands/replaceCommand.js';
import { CursorState } from '../../common/cursorCommon.js';
import { ScrollType, type ICommand } from '../../common/editorCommon.js';
import { createBuiltinLanguageConfigurationService } from '../../common/languages/languageBuiltinConfigurations.js';
import { CursorStateChangedEvent, ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';
import { VerticalRevealType, ViewCursorStateChangedEvent, ViewRevealRangeRequestEvent } from '../../common/viewEvents.js';
import { createTestCursorConfiguration, createTestCursorsController } from './testCursorConfiguration.js';

const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);
const range = (
	startColumn: number,
	endColumn: number,
): Range => Range.fromPositions(
	position(0, startColumn),
	position(0, endColumn),
);
const single = (
	anchorColumn: number,
	activeColumn: number,
): readonly Selection[] => [Selection.fromPositions(
		position(0, anchorColumn),
		position(0, activeColumn),
	)];

test("CursorsController restores command selections", () => {
	using model = new TextModel("hello");
	using controller = createTestCursorsController(
		model,
		single(4, 1),
	);
	const reasons: CursorChangeReason[] = [];
	using listener = controller.onDidChange(
		event => reasons.push(event.reason),
	);

	const change = captureChange(model, () => controller.executeCommand(new ReplaceCommand(range(1, 4), "i")));
	const afterCommand = controller.getSelections();
	const undoChange = controller.context.model.undo();
	const afterUndo = controller.getSelections();
	const redoChange = controller.context.model.redo();

	assert.deepEqual({
		text: model.getText(),
		transactionIds: [
			change?.transactionId,
			undoChange?.transactionId,
			redoChange?.transactionId,
		],
		afterCommand,
		afterUndo,
		afterRedo: controller.getSelections(),
		reasons,
	}, {
		text: "hio",
		transactionIds: [1, 1, 1],
		afterCommand: single(2, 2),
		afterUndo: single(4, 1),
		afterRedo: single(2, 2),
		reasons: [
			CursorChangeReason.NotSet,
			CursorChangeReason.Undo,
			CursorChangeReason.Redo,
		],
	});
});

test('CursorsController executes canonical ICommand edits with undoable selections', () => {
	using model = new TextModel('hello');
	using controller = createTestCursorsController(model, single(1, 4));

	controller.executeCommand(new ReplaceCommand(range(1, 4), 'i'));
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, {
		text: 'hio',
		selections: single(2, 2),
	});
	controller.context.model.undo();
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, {
		text: 'hello',
		selections: single(1, 4),
	});
});

test('CursorsController setStates enforces the configured cursor limit and emits canonical events', () => {
	using model = new TextModel('abcdef');
	using controller = createTestCursorsController(model, single(0, 0), { multiCursorLimit: 2 });
	const collector = new ViewModelEventsCollector();
	let selectionChanges = 0;
	using listener = controller.onDidChange(() => selectionChanges += 1);

	const changed = controller.setStates(collector, 'test', CursorChangeReason.Explicit, CursorState.fromModelSelections([
		...single(1, 1),
		...single(3, 3),
		...single(5, 5),
	]));

	assert.equal(changed, true);
	assert.deepEqual(controller.getSelections(), [...single(1, 1), ...single(3, 3)]);
	assert.equal(collector.viewEvents[0] instanceof ViewCursorStateChangedEvent, true);
	assert.equal(collector.outgoingEvents[0] instanceof CursorStateChangedEvent, true);
	assert.equal((collector.outgoingEvents[0] as CursorStateChangedEvent).reachedMaxCursorCount, true);
	assert.equal(selectionChanges, 1);
});

test('CursorsController owns column selection data and clears it on a state change', () => {
	using model = new TextModel('a\tbc', { tabSize: 4 });
	using controller = createTestCursorsController(model, single(1, 4));
	const stored = { isReal: true, fromViewLineNumber: 7, fromViewVisualColumn: 8, toViewLineNumber: 9, toViewVisualColumn: 10 };
	controller.setCursorColumnSelectData(stored);
	assert.deepEqual(controller.getCursorColumnSelectData(), stored);

	controller.setStates(new ViewModelEventsCollector(), 'test', CursorChangeReason.Explicit, CursorState.fromModelSelections(single(0, 0)));
	assert.deepEqual(controller.getCursorColumnSelectData(), {
		isReal: false,
		fromViewLineNumber: 1,
		fromViewVisualColumn: 0,
		toViewLineNumber: 1,
		toViewVisualColumn: 0,
	});
});

test('CursorsController saves directional selections and restores them with an immediate reveal', () => {
	using model = new TextModel('abcdef');
	using controller = createTestCursorsController(model, single(5, 2));
	const saved = controller.saveState();
	controller.setStates(new ViewModelEventsCollector(), 'test', CursorChangeReason.Explicit, CursorState.fromModelSelections(single(0, 0)));
	const collector = new ViewModelEventsCollector();

	controller.restoreState(collector, saved);

	assert.deepEqual(controller.getSelections(), single(5, 2));
	const reveal = collector.viewEvents.at(-1);
	assert.equal(reveal instanceof ViewRevealRangeRequestEvent, true);
	assert.equal((reveal as ViewRevealRangeRequestEvent).verticalType, VerticalRevealType.Simple);
	assert.equal((reveal as ViewRevealRangeRequestEvent).scrollType, ScrollType.Immediate);
});

test('CursorsController refreshes configuration and focused undo state', () => {
	using model = new TextModel('abcdef');
	using editor = createTestCursorsController(model, single(1, 4));
	using observer = createTestCursorsController(model, single(6, 6));
	using languages = createBuiltinLanguageConfigurationService();
	const readOnlyConfiguration = createTestCursorConfiguration(model, languages, { readOnly: true });
	editor.updateConfiguration(readOnlyConfiguration);
	assert.equal(editor.context.cursorConfig.readOnly, true);
	editor.updateConfiguration(createTestCursorConfiguration(model, languages));

	editor.executeCommand(new ReplaceCommand(range(1, 4), 'i'));
	observer.setHasFocus(true);
	editor.context.model.undo();

	assert.deepEqual(observer.getSelections(), single(1, 4));
});

test('Canonical commands share history until pushUndoStop creates a boundary', () => {
	using coalescedModel = new TextModel('');
	using coalesced = createTestCursorsController(coalescedModel, single(0, 0));
	coalesced.executeCommand(new ReplaceCommand(range(0, 0), 'a'));
	coalesced.executeCommand(new ReplaceCommand(range(1, 1), 'b'));
	assert.equal(coalescedModel.getText(), 'ab');
	coalesced.context.model.undo();
	assert.equal(coalescedModel.getText(), '');

	using isolatedModel = new TextModel('');
	using isolated = createTestCursorsController(isolatedModel, single(0, 0));
	isolated.executeCommand(new ReplaceCommand(range(0, 0), 'a'));
	isolated.pushUndoStop();
	isolated.executeCommand(new ReplaceCommand(range(1, 1), 'b'));
	isolated.context.model.undo();
	assert.equal(isolatedModel.getText(), 'a');
});

test('CommandExecutor keeps the first edit and merges converged cursors when commands overlap', () => {
	using model = new TextModel('abcd');
	const before = [Selection.fromPositions(position(0, 1)), Selection.fromPositions(position(0, 2))];
	using controller = createTestCursorsController(model, before);

	controller.executeCommands([
		new ReplaceCommand(range(1, 3), 'X'),
		new ReplaceCommand(range(2, 4), 'Y'),
	]);

	assert.equal(model.getText(), 'aXd');
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(position(0, 2))]);
});

test('CursorsController executes one command against the primary cursor only', () => {
	using model = new TextModel('abcd');
	using controller = createTestCursorsController(model, [
		Selection.fromPositions(position(0, 1)),
		Selection.fromPositions(position(0, 3)),
	]);

	controller.executeCommand(new ReplaceCommand(range(1, 2), 'X'));

	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: 'aXcd',
		selections: single(2, 2),
	});
});

test('Cursor marker recovery rejects an untracked selection', () => {
	using model = new TextModel('abc');
	using controller = createTestCursorsController(model, single(0, 0));
	const cursor = new Cursor(controller.context);
	cursor.stopTrackingSelection(controller.context);

	assert.throws(() => cursor.readSelectionFromMarkers(controller.context), /not being tracked/);
	cursor.dispose(controller.context);
});

test('CommandExecutor resolves tracked selections after model edits', () => {
	using model = new TextModel('abcd');
	const selection = Selection.fromPositions(position(0, 2), position(0, 4));
	using controller = createTestCursorsController(model, [selection]);

	controller.executeCommand(new ReplaceCommandThatPreservesSelection(range(0, 0), 'X', selection));

	assert.equal(model.getText(), 'Xabcd');
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(position(0, 3), position(0, 5))]);
});

test("Read-only editor instances preserve selection while rejecting document commands", () => {
	using model = new TextModel("abc");
	using controller = createTestCursorsController(model, single(0, 0), { readOnly: true });

	assert.equal(controller.context.cursorConfig.readOnly, true);
	controller.executeCommand(new ReplaceCommand(range(0, 0), "X"));
	assert.equal(model.getText(), "abc");
	assert.deepEqual(controller.getSelections(), single(0, 0));
	controller.setSelections(single(2, 2));
	assert.deepEqual(controller.getSelections(), single(2, 2));
	assert.equal(model.undo(), undefined);
	assert.equal(model.redo(), undefined);
});

test("Cursor-only selection history restores multi-cursor operations without changing document undo", () => {
	using model = new TextModel("abc");
	using controller = createTestCursorsController(model, single(0, 0), { cursorHistoryLimit: 1 });
	const reasons: CursorChangeReason[] = [];
	using listener = controller.onDidChange(event => reasons.push(event.reason));
	const first = primaryFirst([
		Selection.fromPositions(position(0, 0)),
		Selection.fromPositions(position(0, 1)),
	], 1);
	const second = primaryFirst([
		Selection.fromPositions(position(0, 0)),
		Selection.fromPositions(position(0, 1)),
		Selection.fromPositions(position(0, 2)),
	], 2);

	controller.setCursorSelections(first);
	controller.setCursorSelections(second);
	assert.equal(controller.undoCursorOperation(), true);
	assert.deepEqual(controller.getSelections(), first);
	assert.equal(controller.redoCursorOperation(), true);
	assert.deepEqual(controller.getSelections(), second);
	assert.equal(controller.redoCursorOperation(), false);
	assert.equal(controller.undoCursorOperation(), true);
	controller.setCursorSelections(second);
	controller.setSelections(single(2, 2));
	assert.equal(controller.undoCursorOperation(), false);
	assert.equal(model.version, 1);
	assert.deepEqual(reasons, [
		CursorChangeReason.Explicit,
		CursorChangeReason.Explicit,
		CursorChangeReason.Explicit,
		CursorChangeReason.Explicit,
		CursorChangeReason.Explicit,
		CursorChangeReason.Explicit,
		CursorChangeReason.NotSet,
	]);
});

test("CursorsController maps external model edits", () => {
	using model = new TextModel("abc");
	using controller = createTestCursorsController(
		model,
		single(2, 1),
	);
	const events: unknown[] = [];
	using listener = controller.onDidChange(event => events.push(event));

	model.applyEdits([{ range: range(0, 0), text: "X" }]);

	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
		events,
	}, {
		text: "Xabc",
		selections: single(3, 2),
		events: [{
			selections: single(3, 2),
			reason: CursorChangeReason.RecoverFromMarkers,
			modelVersion: 2,
		}],
	});
});

test("CursorsController projects tracked selections before downstream command listeners", () => {
	using model = new TextModel("const value = 1;\n");
	using controller = createTestCursorsController(
		model,
		[Selection.fromPositions(
			new Position((0) + 1, (0) + 1),
			model.positionAt(model.length),
		)],
	);
	const observed: Selection[] = [];
	using listener = model.onDidChangeContent(() => {
		const selection = controller.getSelections()[0]!;
		assert.doesNotThrow(() => {
			model.offsetAt(selection.getSelectionStart());
			model.offsetAt(selection.getPosition());
		});
		observed.push(selection);
	});

	controller.executeCommand(new ReplaceCommand(
		Range.fromPositions(new Position((0) + 1, (0) + 1), model.positionAt(model.length)),
		"x",
	));

	assert.deepEqual(observed, [Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1))]);
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(new Position((0) + 1, (1) + 1))]);
});

test("CursorsController releases tracked ranges without taking their model ownership", () => {
	const tracker = new DisposableTracker();
	{
		using installation = installDisposableTracker(tracker);
		using model = new TextModel("abc");
		using controller = createTestCursorsController(model, single(0, 0));

		controller.setSelections(single(2, 2));
	}

	tracker.assertNoLeaks();
});

test("Shared editors retain independent selection ownership", () => {
	using model = new TextModel("abc");
	using first = createTestCursorsController(model, single(1, 1));
	using second = createTestCursorsController(model, single(3, 3));

	first.executeCommand(new ReplaceCommand(range(1, 1), "X"));
	assert.deepEqual({
		first: first.getSelections(),
		second: second.getSelections(),
	}, {
		first: single(2, 2),
		second: single(4, 4),
	});

	second.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		first: first.getSelections(),
		second: second.getSelections(),
	}, {
		text: "abc",
		first: single(1, 1),
		second: single(3, 3),
	});

	first.context.model.redo();
	assert.deepEqual({
		text: model.getText(),
		first: first.getSelections(),
		second: second.getSelections(),
	}, {
		text: "aXbc",
		first: single(2, 2),
		second: single(4, 4),
	});
});

test("CursorsController leaves the model unchanged when command collection fails", () => {
	using model = new TextModel("abc");
	using controller = createTestCursorsController(
		model,
		single(0, 0),
	);

	const command: ICommand = {
		getEditOperations(_model, builder): void {
			builder.addEditOperation(range(1, 2), "");
			throw new RangeError("Invalid test command");
		},
		computeCursorState(): Selection {
			return Selection.fromPositions(position(0, 0));
		},
	};
	assert.throws(() => controller.executeCommand(command), /Invalid test command/);
	assert.deepEqual({
		text: model.getText(),
		version: model.version,
		selections: controller.getSelections(),
	}, {
		text: "abc",
		version: 1,
		selections: single(0, 0),
	});
});

test("CursorsController disposal does not own the model", () => {
	using model = new TextModel("abc");
	const controller = createTestCursorsController(
		model,
		single(0, 0),
	);
	controller.dispose();

	assert.throws(
		() => controller.getSelections(),
		/already disposed/,
	);
	model.applyEdits([{ range: range(0, 1), text: "A" }]);
	assert.equal(model.getText(), "Abc");
});

test("CursorsController resolves command selections after reentrant model edits", () => {
	using model = new TextModel("abc");
	using controller = createTestCursorsController(
		model,
		single(0, 0),
	);
	const reasons: CursorChangeReason[] = [];
	using controllerListener = controller.onDidChange(
		event => reasons.push(event.reason),
	);
	using reentrantListener = model.onDidChangeContent(event => {
		if (event.version === 2) {
			model.applyEdits([{
				range: Range.fromPositions(model.positionAt(model.getText().length)),
				text: "Y",
			}]);
		}
	});

	controller.executeCommand(new ReplaceCommand(range(0, 0), "X"));

	assert.deepEqual({
		text: model.getText(),
		version: model.version,
		selections: controller.getSelections(),
		reasons,
	}, {
		text: "XabcY",
		version: 3,
		selections: single(1, 1),
		reasons: [],
	});
});

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}

function captureChange(model: TextModel, operation: () => void): TextModelChange | undefined {
	let change: TextModelChange | undefined;
	const listener = model.onDidChangeContent(event => change = event);
	try {
		operation();
	} finally {
		listener.dispose();
	}
	return change;
}
