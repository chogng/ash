import { type URI } from "../../../base/common/uri.js";

export interface TextResourceLanguageInput {
	readonly resource: URI;
	readonly contentType?: string;
	readonly firstLine?: string;
}

export interface TextResourceLanguageResolver {
	resolveLanguageId(input: TextResourceLanguageInput): string | undefined;
}

/** Returns whether an input carries an explicit text or known source-language hint. */
export function isTextResourceLanguageInput(input: TextResourceLanguageInput, resolver?: TextResourceLanguageResolver): boolean {
	return input.contentType?.startsWith("text/") === true ||
		resolver?.resolveLanguageId(input) !== undefined;
}

/** Resolves the canonical language identity for one text resource. */
export function resolveTextResourceLanguageId(input: TextResourceLanguageInput, resolver?: TextResourceLanguageResolver): string {
	return resolver?.resolveLanguageId(input) ?? "plaintext";
}
