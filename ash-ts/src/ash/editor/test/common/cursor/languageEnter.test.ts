import { registerTestTokens } from '../testTokenization.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { TypeOperations } from "../../../common/cursor/cursorTypeOperations.js";
import { EnterOperation } from "../../../common/cursor/cursorTypeEditOperations.js";
import { EditorIndentationKind, resolveEditorIndentationOptions, type EditorIndentationOptions } from "../../../common/core/misc/indentation.js";
import { registerBuiltinLanguageConfigurations } from '../../../standalone/common/builtinLanguages.js';
import { IndentAction } from "../../../common/languages/languageConfiguration.js";
import { TestLanguageConfigurationService } from '../modes/testLanguageConfigurationService.js';
import { type ResolvedLanguageConfiguration } from "../../../common/languages/languageConfigurationRegistry.js";
import { Selection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { TextModel } from "../../../common/model/textModel.js";
import { createTestCursorConfiguration, createTestCursorsController, executeTestEditOperation } from '../testCursorConfiguration.js';
import { Event } from '../../../../base/common/event.js';
import { EditOperationType } from '../../../common/cursorCommon.js';
import { ViewModelEventsCollector } from '../../../common/viewModelEventDispatcher.js';

test("Language Enter creates an indented line between configured brackets", () => {
	using model = new TextModel("if (ok) {}");
	using selections = createTestCursorsController(model, [caret(9)]);
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);

	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("typescript"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	}));

	assert.equal(model.getText(), "if (ok) {\n  \n}");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(new Position((1) + 1, (2) + 1)));
});

test("Rust Enter continues line comments and applies Rust bracket indentation", () => {
	using commentModel = new TextModel("  // explain");
	using commentSelections = createTestCursorsController(commentModel, [caret(12)]);
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	const indentation = { kind: EditorIndentationKind.Spaces, tabSize: 2 } as const;

	executeTestEditOperation(commentSelections, createLanguageEnterCommand(commentModel, commentSelections.getSelections(), configurations.getLanguageConfiguration("rust"), { indentation }));
	assert.equal(commentModel.getText(), "  // explain\n  // ");

	using blockModel = new TextModel("fn main() {}");
	using blockSelections = createTestCursorsController(blockModel, [caret(11)]);
	executeTestEditOperation(blockSelections, createLanguageEnterCommand(blockModel, blockSelections.getSelections(), configurations.getLanguageConfiguration("rust"), { indentation }));
	assert.equal(blockModel.getText(), "fn main() {\n  \n}");
});

test("Explicit on-enter rules precede bracket fallback and continue documentation comments", () => {
	using model = new TextModel("/** */");
	using selections = createTestCursorsController(model, [caret(3)]);
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);

	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("typescript"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	}));

	assert.equal(model.getText(), "/**\n * \n */");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(new Position((1) + 1, (3) + 1)));
});

test("On-enter rules observe previous, before, and after text in registration order", () => {
	using model = new TextModel("header\n  beginEND");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((1) + 1, (7) + 1), new Position((1) + 1, (10) + 1))]);
	using configurations = new TestLanguageConfigurationService();
	using rules = configurations.register("demo", {
		onEnterRules: [
			{
				previousLineText: /^header$/,
				beforeText: /begin$/,
				afterText: /^$/,
				action: { indentAction: IndentAction.Indent, appendText: "first" },
			},
			{
				beforeText: /begin$/,
				action: { indentAction: IndentAction.None, appendText: "second" },
			},
		],
	});

	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("demo"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	}));

	assert.equal(model.getText(), "header\n  begin\n    first");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(new Position((2) + 1, (9) + 1)));
});

test("Indentation rules increase, decrease, and ignore matching lines", () => {
	using configurations = new TestLanguageConfigurationService();
	using rules = configurations.register("demo", {
		indentationRules: {
			increaseIndentPattern: /:\s*$/,
			decreaseIndentPattern: /^end\b/,
			unIndentedLinePattern: /^\s*\*/,
		},
	});
	const configuration = configurations.getLanguageConfiguration("demo");
	const indentation = { kind: EditorIndentationKind.Spaces, tabSize: 2 } as const;

	using increaseModel = new TextModel("  block:");
	using increaseSelections = createTestCursorsController(increaseModel, [caret(8)]);
	executeTestEditOperation(increaseSelections, createLanguageEnterCommand(increaseModel, increaseSelections.getSelections(), configuration, { indentation }));
	assert.equal(increaseModel.getText(), "  block:\n    ");

	using decreaseModel = new TextModel("    valueend");
	using decreaseSelections = createTestCursorsController(decreaseModel, [caret(9)]);
	executeTestEditOperation(decreaseSelections, createLanguageEnterCommand(decreaseModel, decreaseSelections.getSelections(), configuration, { indentation }));
	assert.equal(decreaseModel.getText(), "    value\n  end");

	using ignoredModel = new TextModel("  *:");
	using ignoredSelections = createTestCursorsController(ignoredModel, [caret(4)]);
	executeTestEditOperation(ignoredSelections, createLanguageEnterCommand(ignoredModel, ignoredSelections.getSelections(), configuration, { indentation }));
	assert.equal(ignoredModel.getText(), "  *:\n  ");
});

test("Language Enter maps multiple cursors through one pre-change transaction", () => {
	using model = new TextModel("{} []");
	using selections = createTestCursorsController(model, primaryFirst([caret(1), caret(4)], 1));
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);

	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("typescript"), {
		indentation: {
			kind: EditorIndentationKind.Tabs,
			tabSize: 4,
		},
	}));

	assert.equal(model.getText(), "{\n\t\n} [\n\t\n]");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		Selection.fromPositions(new Position((1) + 1, (1) + 1)),
		Selection.fromPositions(new Position((3) + 1, (1) + 1)),
	], 1));
});

test("Language Enter starts a new typing history group that following text may join", () => {
	using model = new TextModel("{");
	using selections = createTestCursorsController(model, [caret(1)]);
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	typeText(selections, model, ' ');
	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("typescript"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	}));
	typeText(selections, model, 'x');
	assert.equal(model.getText(), "{ \n  x");

	selections.context.model.undo();
	assert.equal(model.getText(), "{ ");
	assert.deepEqual(selections.getSelections()[0]!, caret(2));
	selections.context.model.undo();
	assert.equal(model.getText(), "{");
});

test("Language Enter normalizes removeText and validates editor indentation before mutation", () => {
	using model = new TextModel("    stop");
	using selections = createTestCursorsController(model, [caret(8)]);
	using configurations = new TestLanguageConfigurationService();
	using rule = configurations.register("demo", {
		onEnterRules: [{
			beforeText: /stop$/,
			action: { indentAction: IndentAction.None, removeText: 2 },
		}],
	});
	const command = createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("demo"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	});
	executeTestEditOperation(selections, command);
	assert.equal(model.getText(), "    stop\n  ");

	assert.throws(() => createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("demo"), {
		indentation: { tabSize: 0 },
	}), /tab size/);
	assert.equal(model.getText(), "    stop\n  ");
});

test("Language Enter ignores bracket-looking text in strings and comments", async () => {
	assert.deepEqual(await enterWithTokens("const text = \"{\"", new Position((0) + 1, (16) + 1)), {
		text: "const text = \"{\"\n",
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(await enterWithTokens("// {", new Position((0) + 1, (4) + 1)), {
		text: "// {\n",
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(await enterWithTokens("/*\n{", new Position((1) + 1, (1) + 1)), {
		text: "/*\n{\n",
		position: new Position((2) + 1, (0) + 1),
	});
	assert.deepEqual(await enterWithTokens("if (ok) {", new Position((0) + 1, (9) + 1)), {
		text: "if (ok) {\n  ",
		position: new Position((1) + 1, (2) + 1),
	});
});


test("EnterOperation inserts blank lines before and after every cursor line", () => {
	using model = new TextModel("zero\none\ntwo");
	using selections = createTestCursorsController(model, primaryFirst([
		Selection.fromPositions(new Position(1, 2)),
		Selection.fromPositions(new Position(3, 2)),
	], 1));
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	const config = createTestCursorConfiguration(model, configurations);

	selections.executeCommands(EnterOperation.lineInsertBefore(config, model, selections.getSelections()));
	assert.equal(model.getText(), "\nzero\none\n\ntwo");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		Selection.fromPositions(new Position(1, 1)),
		Selection.fromPositions(new Position(4, 1)),
	], 1));

	selections.executeCommands(EnterOperation.lineInsertAfter(config, model, selections.getSelections()));
	assert.equal(model.getText(), "\n\nzero\none\n\n\ntwo");
});

async function enterWithTokens(initialText: string, position: Position): Promise<{ readonly text: string; readonly position: Position }> {
	using tokens = registerTestTokens(new Map([
		['const text = "{"', [{ offset: 0, type: "" }, { offset: 13, type: "string" }]],
		["// {", [{ offset: 0, type: "comment" }]],
		["/*", [{ offset: 0, type: "comment" }]],
		["{", [{ offset: 0, type: "comment" }]],
	]));
	using model = new TextModel(initialText, { languageId: "typescript" });
	await new Promise(resolve => setImmediate(resolve));
	using selections = createTestCursorsController(model, [Selection.fromPositions(position)]);
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	executeTestEditOperation(selections, createLanguageEnterCommand(model, selections.getSelections(), configurations.getLanguageConfiguration("typescript"), {
		indentation: {
			kind: EditorIndentationKind.Spaces,
			tabSize: 2,
		},
	}));
	return {
		text: model.getText(),
		position: selections.getSelections()[0]!.getPosition(),
	};
}

function caret(columnIndex: number): Selection {
	return Selection.fromPositions(new Position((0) + 1, (columnIndex) + 1));
}

function createLanguageEnterCommand(
	model: TextModel,
	selections: readonly Selection[],
	configuration: ResolvedLanguageConfiguration,
	options: { readonly indentation?: EditorIndentationOptions } = {},
) {
	resolveEditorIndentationOptions(options.indentation);
	const languageConfigurationService = {
		_serviceBrand: undefined,
		onDidChange: Event.None,
		register: () => { throw new Error('Test language configuration is read-only'); },
		getLanguageConfiguration: () => configuration,
	};
	const indentation = options.indentation;
	if (indentation) model.updateOptions({ insertSpaces: indentation.kind !== EditorIndentationKind.Tabs, tabSize: indentation.tabSize, indentSize: indentation.tabSize });
	const config = createTestCursorConfiguration(model, languageConfigurationService);
	return TypeOperations.typeWithInterceptors(false, EditOperationType.Other, config, model, [...selections], [], '\n');
}

function typeText(selections: import('../../../common/cursor/cursor.js').CursorsController, model: TextModel, text: string): void {
	void model;
	selections.type(new ViewModelEventsCollector(), text, 'test');
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
