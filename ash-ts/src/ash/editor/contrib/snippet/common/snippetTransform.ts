/** One immutable regular-expression transform declared by a completion snippet. */
export interface SnippetTransform {
	readonly pattern: string;
	readonly format: string;
	readonly options: string;
}

/**
 * Validates a completion-snippet regular-expression transform without making
 * browser DOM or editor-model state part of the snippet grammar.
 */
export function createSnippetTransform(pattern: string, format: string, options: string): SnippetTransform {
	if (typeof pattern !== "string" || typeof format !== "string" || typeof options !== "string") {
		throw new TypeError("Language completion snippet transforms require string pattern, format, and options");
	}
	if (!/^[dgimsuvy]*$/u.test(options) || new Set(options).size !== options.length) {
		throw new SyntaxError(`Language completion snippet transform options '${options}' are invalid`);
	}
	try {
		new RegExp(pattern, options);
	} catch (error) {
		throw new SyntaxError(`Language completion snippet transform pattern is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	return Object.freeze({ pattern, format, options });
}

/** Applies one validated completion-snippet transform to an expanded value. */
export function applySnippetTransform(value: string, transform: SnippetTransform): string {
	if (typeof value !== "string") throw new TypeError("Language completion snippet transform value must be a string");
	return value.replace(new RegExp(transform.pattern, transform.options), (...arguments_: unknown[]) => {
		const trailingArgumentCount = typeof arguments_.at(-1) === "object" ? 3 : 2;
		const captures = arguments_.slice(0, -trailingArgumentCount).map(capture => typeof capture === "string" ? capture : "");
		return expandTransformFormat(transform.format, captures);
	});
}

function expandTransformFormat(format: string, captures: readonly string[]): string {
	let result = "";
	for (let offset = 0; offset < format.length;) {
		const character = format[offset]!;
		if (character === "\\") {
			const escaped = format[offset + 1];
			if (escaped === undefined) throw new SyntaxError("Language completion snippet transform format must not end with an escape");
			result += escaped;
			offset += 2;
			continue;
		}
		if (character !== "$") {
			result += character;
			offset += 1;
			continue;
		}
		const next = format[offset + 1];
		if (next !== "{") {
			const endOffset = readDigitsEnd(format, offset + 1);
			if (endOffset === offset + 1) {
				result += character;
				offset += 1;
			} else {
				result += captureAt(captures, Number(format.slice(offset + 1, endOffset)));
				offset = endOffset;
			}
			continue;
		}
		const expression = readBracedExpression(format, offset + 2);
		result += expandBracedCaptureExpression(expression.text, captures);
		offset = expression.nextOffset;
	}
	return result;
}

function expandBracedCaptureExpression(expression: string, captures: readonly string[]): string {
	const separator = expression.indexOf(":");
	const indexText = separator < 0 ? expression : expression.slice(0, separator);
	if (!/^\d+$/u.test(indexText)) throw new SyntaxError("Language completion snippet transform capture must be numeric");
	const capture = captureAt(captures, Number(indexText));
	if (separator < 0) return capture;
	const directive = expression.slice(separator + 1);
	if (directive === "/upcase") return capture.toLocaleUpperCase();
	if (directive === "/downcase") return capture.toLocaleLowerCase();
	if (directive === "/capitalize") return capitalize(capture);
	if (directive === "/camelcase") return camelCase(capture);
	if (directive === "/pascalcase") return pascalCase(capture);
	if (directive.startsWith("+")) return capture.length > 0 ? expandTransformFormat(directive.slice(1), captures) : "";
	if (directive.startsWith("-")) return capture.length === 0 ? expandTransformFormat(directive.slice(1), captures) : "";
	if (directive.startsWith("?")) {
		const condition = splitConditional(directive.slice(1));
		return capture.length > 0
			? expandTransformFormat(condition.whenTruthy, captures)
			: expandTransformFormat(condition.whenFalsy, captures);
	}
	return capture.length === 0 ? expandTransformFormat(directive, captures) : capture;
}

function readBracedExpression(format: string, startOffset: number): { readonly text: string; readonly nextOffset: number } {
	let depth = 0;
	let text = "";
	for (let offset = startOffset; offset < format.length; offset += 1) {
		const character = format[offset]!;
		if (character === "\\") {
			const escaped = format[offset + 1];
			if (escaped === undefined) throw new SyntaxError("Language completion snippet transform format must not end with an escape");
			text += character + escaped;
			offset += 1;
			continue;
		}
		if (character === "{") {
			depth += 1;
			text += character;
			continue;
		}
		if (character === "}") {
			if (depth === 0) return Object.freeze({ text, nextOffset: offset + 1 });
			depth -= 1;
			text += character;
			continue;
		}
		text += character;
	}
	throw new SyntaxError("Unclosed completion snippet transform format expression");
}

function splitConditional(value: string): { readonly whenTruthy: string; readonly whenFalsy: string } {
	let depth = 0;
	for (let offset = 0; offset < value.length; offset += 1) {
		const character = value[offset]!;
		if (character === "\\") {
			offset += 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") depth -= 1;
		else if (character === ":" && depth === 0) {
			return Object.freeze({ whenTruthy: value.slice(0, offset), whenFalsy: value.slice(offset + 1) });
		}
	}
	return Object.freeze({ whenTruthy: value, whenFalsy: "" });
}

function captureAt(captures: readonly string[], index: number): string {
	return captures[index] ?? "";
}

function readDigitsEnd(value: string, startOffset: number): number {
	let offset = startOffset;
	while (value[offset] !== undefined && value[offset]! >= "0" && value[offset]! <= "9") offset += 1;
	return offset;
}

function capitalize(value: string): string {
	if (value.length === 0) return value;
	return value[0]!.toLocaleUpperCase() + value.slice(1).toLocaleLowerCase();
}

function camelCase(value: string): string {
	const words = splitWords(value);
	return words.map((word, index) => index === 0 ? word.toLocaleLowerCase() : capitalize(word)).join("");
}

function pascalCase(value: string): string {
	return splitWords(value).map(capitalize).join("");
}

function splitWords(value: string): readonly string[] {
	return value.split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0);
}
