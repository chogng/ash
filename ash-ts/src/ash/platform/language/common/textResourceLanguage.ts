import { type URI } from "../../../base/common/uri.js";

export interface TextResourceLanguageInput {
	readonly resource: URI;
	readonly contentType?: string;
	readonly firstLine?: string;
}

export interface TextResourceLanguageResolver {
	resolveLanguageId(input: TextResourceLanguageInput): string | undefined;
}

const CONTENT_TYPE_LANGUAGES = new Map<string, string>([
	["application/json", "json"],
	["application/javascript", "javascript"],
	["application/typescript", "typescript"],
	["text/css", "css"],
	["text/html", "html"],
	["text/javascript", "javascript"],
	["text/markdown", "markdown"],
	["text/plain", "plaintext"],
	["text/typescript", "typescript"],
]);

const EXTENSION_LANGUAGES = new Map<string, string>([
	[".c", "c"],
	[".cc", "cpp"],
	[".cpp", "cpp"],
	[".cs", "csharp"],
	[".css", "css"],
	[".go", "go"],
	[".html", "html"],
	[".java", "java"],
	[".js", "javascript"],
	[".json", "json"],
	[".jsonc", "jsonc"],
	[".jsx", "javascriptreact"],
	[".md", "markdown"],
	[".py", "python"],
	[".rs", "rust"],
	[".sh", "shellscript"],
	[".sql", "sql"],
	[".toml", "ini"],
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".txt", "plaintext"],
	[".xml", "xml"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
]);

/** Returns whether an input carries an explicit text or known source-language hint. */
export function isTextResourceLanguageInput(input: TextResourceLanguageInput, resolver?: TextResourceLanguageResolver): boolean {
	return input.contentType?.startsWith("text/") === true ||
		CONTENT_TYPE_LANGUAGES.has(input.contentType ?? "") ||
		resolver?.resolveLanguageId(input) !== undefined ||
		languageFromPath(input.resource.path) !== undefined;
}

/** Resolves the canonical language identity for one text resource. */
export function resolveTextResourceLanguageId(input: TextResourceLanguageInput, resolver?: TextResourceLanguageResolver): string {
	return CONTENT_TYPE_LANGUAGES.get(input.contentType ?? "") ??
		resolver?.resolveLanguageId(input) ??
		languageFromPath(input.resource.path) ??
		"plaintext";
}

function languageFromPath(path: string): string | undefined {
	const fileName = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return EXTENSION_LANGUAGES.get(fileName.slice(dot));
}
