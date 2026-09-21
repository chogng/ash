import { decodeSyntaxWireResult, encodeSyntaxWireResult } from "./syntaxWireResult.js";
import { assertSyntaxRequest, type SyntaxRequest } from '../../languages.js';
import { SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, type SyntaxLane, type SyntaxResult } from "./syntaxService.js";
import { type LanguageWorkerWireCodec } from "../languageWorkerWire.js";
import { type TextSnapshot } from "../../core/textChange.js";

export const syntaxWireCodec: LanguageWorkerWireCodec<SyntaxLane, SyntaxRequest, SyntaxResult> = Object.freeze({
	lanes: Object.freeze([SYNTAX_TOKEN_LANE, SYNTAX_DIAGNOSTIC_LANE] as const),
	resultProtocol: "confirmedBase",
	encodePayload(_lane: SyntaxLane, request: SyntaxRequest) {
		assertSyntaxRequest(request);
		return Object.freeze({ languageId: request.languageId });
	},
	decodePayload(_lane: SyntaxLane, value: unknown, _snapshot: TextSnapshot) {
		assertRecord(value, "Syntax wire request");
		const request = Object.freeze({
			languageId: decodeString(value.languageId, "Syntax wire language ID"),
		});
		assertSyntaxRequest(request);
		return request;
	},
	encodeResult: encodeSyntaxWireResult,
	decodeResult: decodeSyntaxWireResult,
});

function decodeString(value: unknown, owner: string): string {
	if (typeof value !== "string") throw new TypeError(`${owner} must be a string`);
	return value;
}

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
}
