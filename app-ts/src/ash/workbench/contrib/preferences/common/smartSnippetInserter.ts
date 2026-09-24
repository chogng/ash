import { Position } from '../../../../editor/common/core/position.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { JsonTokenKind, scanJson, type JsonToken } from '../../../../base/common/json.js';

export interface InsertSnippetResult {
	readonly position: Position;
	readonly prepend: string;
	readonly append: string;
}

const enum InsertionState {
	Invalid,
	AfterObject,
	BeforeObject,
}

/** Finds a structurally safe insertion point for an object snippet in a JSONC array. */
export class SmartSnippetInserter {
	public static insertSnippet(model: TextModel, desiredPosition: Position): InsertSnippetResult {
		const source = model.getText();
		const desiredOffset = model.offsetAt(desiredPosition);
		const tokens = scanJson(source, { allowComments: true, allowTrailingComma: true }).tokens;
		let arrayLevel = 0;
		let objectLevel = 0;
		let currentState = InsertionState.Invalid;
		let lastValidOffset = -1;
		let lastValidState = InsertionState.Invalid;

		const updateState = (token: JsonToken, state: InsertionState): void => {
			if (state !== InsertionState.Invalid && arrayLevel === 1 && objectLevel === 0) {
				currentState = state;
					lastValidOffset = token.offset + token.length;
				lastValidState = state;
			} else if (currentState !== InsertionState.Invalid) {
				currentState = InsertionState.Invalid;
					lastValidOffset = token.offset;
			}
		};

		for (const token of tokens) {
			let isSafeToken = false;
			switch (token.kind) {
				case JsonTokenKind.OpenBracket:
					isSafeToken = true;
					arrayLevel += 1;
					updateState(token, InsertionState.BeforeObject);
					break;
				case JsonTokenKind.CloseBracket:
					isSafeToken = true;
					arrayLevel -= 1;
					updateState(token, InsertionState.Invalid);
					break;
				case JsonTokenKind.Comma:
					isSafeToken = true;
					updateState(token, InsertionState.BeforeObject);
					break;
				case JsonTokenKind.OpenBrace:
					isSafeToken = true;
					objectLevel += 1;
					updateState(token, InsertionState.Invalid);
					break;
				case JsonTokenKind.CloseBrace:
					isSafeToken = true;
					objectLevel -= 1;
					updateState(token, InsertionState.AfterObject);
					break;
				case JsonTokenKind.Trivia:
					isSafeToken = true;
					break;
				case JsonTokenKind.LineComment:
				case JsonTokenKind.BlockComment:
				case JsonTokenKind.Colon:
				case JsonTokenKind.String:
				case JsonTokenKind.Number:
				case JsonTokenKind.True:
				case JsonTokenKind.False:
				case JsonTokenKind.Null:
				case JsonTokenKind.Unknown:
					break;
			}

			if (token.offset + token.length < desiredOffset || (currentState === InsertionState.Invalid && lastValidOffset < 0)) continue;
			const acceptedState = (currentState === InsertionState.Invalid ? lastValidState : currentState) as InsertionState;
			const acceptedOffset = currentState === InsertionState.Invalid
				? lastValidOffset
				: isSafeToken ? token.offset + token.length : token.offset;
			if (acceptedState === InsertionState.AfterObject) {
				return Object.freeze({ position: model.positionAt(acceptedOffset), prepend: ',', append: '' });
			}
			return Object.freeze({
				position: model.positionAt(acceptedOffset),
				prepend: '',
					append: tokens.some(candidate => candidate.offset >= acceptedOffset && candidate.kind === JsonTokenKind.OpenBrace) ? ',' : '',
			});
		}

		return Object.freeze({
			position: model.positionAt(model.length),
			prepend: '\n[',
			append: ']',
		});
	}
}
