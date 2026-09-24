/** Largest explicit clipboard text file Stanza will read into one document edit. */
export const TEXT_FILE_TRANSFER_MAX_BYTES = 5 * 1024 * 1024;

/** Browser file capability accepted only after a user supplies it through a transfer. */
export interface TextFileTransfer {
	readonly name: string;
	readonly size: number;
	readonly type: string;
	text(): Promise<string>;
}

/**
 * Selects one plausibly textual browser transfer file without reading a local path.
 *
 * Binary files, unknown empty-MIME extensions, multi-file transfers, and oversized
 * files are deliberately left to the host rather than being decoded into the editor.
 */
export function selectTextFileTransfer(files: Iterable<TextFileTransfer>): TextFileTransfer | undefined {
	const values = [...files];
	if (values.length !== 1) return undefined;
	const file = values[0]!;
	if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > TEXT_FILE_TRANSFER_MAX_BYTES) return undefined;
	if (typeof file.name !== "string" || typeof file.type !== "string" || typeof file.text !== "function") return undefined;
	return isTextualMimeType(file.type) || isKnownTextExtension(file.name) ? file : undefined;
}

function isTextualMimeType(type: string): boolean {
	const normalized = type.toLowerCase().trim();
	return normalized.startsWith("text/") || TEXTUAL_MIME_TYPES.has(normalized);
}

function isKnownTextExtension(name: string): boolean {
	const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	return TEXTUAL_EXTENSIONS.has(extension);
}

const TEXTUAL_MIME_TYPES = new Set([
	"application/json",
	"application/javascript",
	"application/typescript",
	"application/xml",
	"application/x-sh",
	"application/x-yaml",
]);

const TEXTUAL_EXTENSIONS = new Set([
	"bash", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "cxx", "go", "h", "hpp",
	"html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "kts", "lua", "mjs", "md", "php",
	"py", "rb", "rs", "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml", "zsh",
]);
