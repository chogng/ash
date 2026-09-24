import { isMacintosh, isWindows, OperatingSystem } from "./platform.js";
import { URI } from "./uri.js";

/** Inputs used to format a resource as a user-facing path label. */
export interface IPathLabelFormatting {
	readonly os: OperatingSystem;
	readonly tildify?: IUserHomeProvider;
	readonly relative?: IRelativePathProvider;
}

/** Supplies workspace information for relative resource labels. */
export interface IRelativePathProvider {
	readonly noPrefix?: boolean;

	getWorkspace(): { readonly folders: readonly { readonly uri: URI; readonly name?: string }[] };
	getWorkspaceFolder(resource: URI): { readonly uri: URI; readonly name?: string } | null;
}

/** Supplies the home resource used for `~` path shortening. */
export interface IUserHomeProvider {
	readonly userHome: URI;
}

/** Formats a resource using the target operating system's path conventions. */
export function getPathLabel(resource: URI, formatting: IPathLabelFormatting): string {
	const relative = formatting.relative
		? getRelativePathLabel(resource, formatting.relative, formatting.os)
		: undefined;
	if (relative !== undefined) return relative;

	let path = resourcePath(resource, formatting.os);
	if (formatting.os !== OperatingSystem.Windows && formatting.tildify) {
		path = tildify(path, resourcePath(formatting.tildify.userHome, formatting.os), formatting.os);
	}
	return normalizePath(path, formatting.os);
}

function getRelativePathLabel(resource: URI, provider: IRelativePathProvider, os: OperatingSystem): string | undefined {
	const workspace = provider.getWorkspace();
	const firstFolder = workspace.folders[0];
	if (!firstFolder) return undefined;
	// Workspace providers may compare resources by scheme. When a caller hands
	// us a path-only URI, align it with the first workspace scheme just as VS
	// Code does before asking the provider for ownership.
	if (resource.scheme !== firstFolder.uri.scheme && resource.path.startsWith('/') && !resource.path.startsWith('//')) {
		resource = firstFolder.uri.withPath(resource.path);
	}
	const folder = provider.getWorkspaceFolder(resource);
	if (!folder) return undefined;

	const relative = relativePath(resourcePath(folder.uri, os), resourcePath(resource, os), os);
	if (relative === undefined) return undefined;
	if (workspace.folders.length <= 1 || provider.noPrefix) return relative;
	const rootName = folder.name || basenameOrAuthority(folder.uri);
	return relative ? `${rootName} • ${relative}` : rootName;
}

function resourcePath(resource: URI, os: OperatingSystem): string {
	const path = resource.scheme === "file" ? resource.fsPath : decodeURIComponent(resource.path);
	return os === OperatingSystem.Windows ? path.replaceAll("/", "\\") : path.replaceAll("\\", "/");
}

function relativePath(folder: string, resource: string, os: OperatingSystem): string | undefined {
	const separator = pathSeparator(os);
	const normalizedFolder = normalizePath(folder, os);
	const normalizedResource = normalizePath(resource, os);
	const comparableFolder = os === OperatingSystem.Windows ? normalizedFolder.toLowerCase() : normalizedFolder;
	const comparableResource = os === OperatingSystem.Windows ? normalizedResource.toLowerCase() : normalizedResource;
	if (comparableFolder === comparableResource) return "";
	const prefix = comparableFolder.endsWith(separator) ? comparableFolder : `${comparableFolder}${separator}`;
	if (!comparableResource.startsWith(prefix)) return undefined;
	return normalizedResource.slice(prefix.length);
}

function basenameOrAuthority(resource: URI): string {
	const path = decodeURIComponent(resource.path).replace(/\/+$/u, "");
	const basename = path.slice(path.lastIndexOf("/") + 1);
	return basename || resource.authority || resource.toString();
}

/** Normalizes a drive letter without changing the remainder of the path. */
export function normalizeDriveLetter(path: string, isWindowsOS = isWindows): string {
	if (!isWindowsOS || !/^[A-Za-z]:/u.test(path)) return path;
	return path.charAt(0).toUpperCase() + path.slice(1);
}

/** Replaces a home path prefix with `~` on macOS and Linux. */
export function tildify(path: string, userHome: string, os: OperatingSystem): string {
	if (os === OperatingSystem.Windows || !path || !userHome) return path;
	const normalizedPath = normalizePath(path, os);
	const normalizedHome = trimTrailingSeparators(normalizePath(userHome, os));
	const comparablePath = os === OperatingSystem.Macintosh ? normalizedPath.toLowerCase() : normalizedPath;
	const comparableHome = os === OperatingSystem.Macintosh ? normalizedHome.toLowerCase() : normalizedHome;
	const separator = pathSeparator(os);
	const prefix = `${comparableHome}${separator}`;
	if (!comparablePath.startsWith(prefix)) return path;
	return `~${separator}${normalizedPath.slice(normalizedHome.length + 1)}`;
}

/** Expands a leading tilde path segment using the supplied home path. */
export function untildify(path: string, userHome: string): string {
	return path.replace(/^~(?=$|[\\/])/u, userHome);
}

/** Shortens a group of paths while retaining enough unique context to distinguish them. */
export function shorten(paths: string[], defaultPathSeparator = isWindows ? "\\" : "/"): string[] {
	const shortenedPaths: string[] = new Array(paths.length);
	const urlSchemaRegexp = /^[^:/\\?#]+?:\/\//u;
	const unc = "\\\\";
	const ellipsis = "…";

	for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
		const originalPath = paths[pathIndex];
		if (originalPath === "") {
			shortenedPaths[pathIndex] = `.${defaultPathSeparator}`;
			continue;
		}
		if (!originalPath) {
			shortenedPaths[pathIndex] = originalPath;
			continue;
		}

		let pathSeparator = defaultPathSeparator;
		let prefix = "";
		let trimmedPath = originalPath;
		if (urlSchemaRegexp.test(trimmedPath)) {
			prefix = trimmedPath.slice(0, trimmedPath.indexOf("//") + 2);
			trimmedPath = trimmedPath.slice(trimmedPath.indexOf("//") + 2);
			pathSeparator = "/";
		} else if (trimmedPath.startsWith(unc)) {
			prefix = trimmedPath.slice(0, unc.length);
			trimmedPath = trimmedPath.slice(unc.length);
		} else if (trimmedPath.startsWith(pathSeparator)) {
			prefix = pathSeparator;
			trimmedPath = trimmedPath.slice(pathSeparator.length);
		} else if (trimmedPath.startsWith("~")) {
			prefix = "~";
			trimmedPath = trimmedPath.slice(1);
		}

		const segments = trimmedPath.split(pathSeparator);
		let found = false;
		for (let subpathLength = 1; !found && subpathLength <= segments.length; subpathLength += 1) {
			for (let start = segments.length - subpathLength; !found && start >= 0; start -= 1) {
				let subpath = segments.slice(start, start + subpathLength).join(pathSeparator);
				let matchesOtherPath = false;
				for (let otherPathIndex = 0; !matchesOtherPath && otherPathIndex < paths.length; otherPathIndex += 1) {
					const otherPath = paths[otherPathIndex];
					if (otherPathIndex === pathIndex || !otherPath || !otherPath.includes(subpath)) continue;
					const isSubpathEnding = start + subpathLength === segments.length;
					const subpathWithSeparator = start > 0 && otherPath.includes(pathSeparator)
						? `${pathSeparator}${subpath}`
						: subpath;
					const isOtherPathEnding = otherPath.endsWith(subpathWithSeparator);
					matchesOtherPath = !isSubpathEnding || isOtherPathEnding;
				}
				if (matchesOtherPath) continue;

				let result = "";
				if (segments[0]?.endsWith(":") || prefix !== "") {
					if (start === 1) {
						start = 0;
						subpathLength += 1;
						subpath = segments[0] + pathSeparator + subpath;
					}
					if (start > 0) result = `${segments[0]}${pathSeparator}`;
					result = prefix + result;
				} else {
					result = prefix;
				}
				if (start > 0) result += `${ellipsis}${pathSeparator}`;
				if (!result.endsWith(subpath)) result += subpath;
				if (start + subpathLength < segments.length) {
					result += segments[start + subpathLength] === "" && start + subpathLength === segments.length - 1
						? pathSeparator
						: `${pathSeparator}${ellipsis}`;
				}
				shortenedPaths[pathIndex] = result;
				found = true;
			}
		}
		if (!found) shortenedPaths[pathIndex] = originalPath;
	}
	return shortenedPaths;
}

export interface ISeparator {
	readonly label: string;
}

/** Expands `${variable}` placeholders and omits separators beside empty values. */
export function template(value: string, values: Readonly<Record<string, string | ISeparator | undefined | null>> = {}): string {
	const segments: { readonly value: string; readonly separator: boolean }[] = [];
	let current = "";
	let variable = false;
	for (const character of value) {
		if (character === "$" || (variable && character === "{")) {
			if (current) segments.push({ value: current, separator: false });
			current = "";
			variable = true;
			continue;
		}
		if (character === "}" && variable) {
			const resolved = values[current];
			if (typeof resolved === "string") {
				if (resolved) segments.push({ value: resolved, separator: false });
			} else if (resolved) {
				if (segments.at(-1)?.separator !== true) segments.push({ value: resolved.label, separator: true });
			}
			current = "";
			variable = false;
			continue;
		}
		current += character;
	}
	if (current && !variable) segments.push({ value: current, separator: false });
	return segments.filter((segment, index) => {
		if (!segment.separator) return true;
		const left = segments[index - 1];
		const right = segments[index + 1];
		return Boolean(left?.value && !left.separator && right?.value && !right.separator);
	}).map(segment => segment.value).join("");
}

/** Applies platform-specific mnemonic escaping to a menu label. */
export function mnemonicMenuLabel(label: string, forceDisableMnemonics = false): string {
	if (isMacintosh || forceDisableMnemonics) {
		return label.replace(/\(&&\w\)|&&/gu, "").replace(/&/gu, isMacintosh ? "&" : "&&");
	}
	return label.replace(/&&|&/gu, match => match === "&" ? "&&" : "&");
}

export function mnemonicButtonLabel(label: string, forceDisableMnemonics: true): string;
export function mnemonicButtonLabel(label: string, forceDisableMnemonics?: false): { readonly withMnemonic: string; readonly withoutMnemonic: string };
export function mnemonicButtonLabel(label: string, forceDisableMnemonics = false): { readonly withMnemonic: string; readonly withoutMnemonic: string } | string {
	const withoutMnemonic = label.replace(/\(&&\w\)|&&/gu, "");
	if (forceDisableMnemonics) return withoutMnemonic;
	if (isMacintosh) return { withMnemonic: withoutMnemonic, withoutMnemonic };
	const withMnemonic = isWindows
		? label.replace(/&&|&/gu, match => match === "&" ? "&&" : "&")
		: label.replace(/&&/gu, "_");
	return { withMnemonic, withoutMnemonic };
}

/** Escapes mnemonic markers when a label is displayed outside a native menu. */
export function unmnemonicLabel(label: string): string {
	return label.replace(/&/gu, "&&");
}

/** Splits a recent workspace label into its visible name and containing path. */
export function splitRecentLabel(recentLabel: string): { readonly name: string; readonly parentPath: string } {
	if (recentLabel.endsWith("]")) {
		const suffixStart = recentLabel.lastIndexOf(" [", recentLabel.length - 2);
		if (suffixStart !== -1) {
			const split = splitName(recentLabel.slice(0, suffixStart));
			return { name: split.name + recentLabel.slice(suffixStart), parentPath: split.parentPath };
		}
	}
	return splitName(recentLabel);
}

function splitName(fullPath: string): { readonly name: string; readonly parentPath: string } {
	const separator = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
	const name = fullPath.slice(separator + 1);
	const parentPath = separator === -1 ? "" : fullPath.slice(0, separator) || fullPath.slice(0, separator + 1);
	return name ? { name, parentPath } : { name: parentPath, parentPath: "" };
}

function pathSeparator(os: OperatingSystem): "\\" | "/" {
	return os === OperatingSystem.Windows ? "\\" : "/";
}

function normalizePath(path: string, os: OperatingSystem): string {
	const separator = pathSeparator(os);
	const normalized = os === OperatingSystem.Windows ? path.replaceAll("/", "\\") : path.replaceAll("\\", "/");
	const drive = os === OperatingSystem.Windows ? /^([A-Za-z]:)([\\/]?)/u.exec(normalized) : undefined;
	const unc = os === OperatingSystem.Windows && normalized.startsWith("\\\\");
	const absolute = normalized.startsWith(separator) || Boolean(drive) || unc;
	const prefix = drive ? `${drive[1]}${drive[2] ? separator : ""}` : unc ? "\\\\" : normalized.startsWith(separator) ? separator : "";
	const segments = normalized.slice(prefix.length).split(separator);
	const result: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === ".." && result.length > 0 && result.at(-1) !== "..") {
			result.pop();
			continue;
		}
		if (segment !== ".." || absolute === false) result.push(segment);
	}
	const body = result.join(separator);
	if (prefix) return `${prefix}${body}` || prefix;
	return body || (absolute ? separator : ".");
}

function trimTrailingSeparators(path: string): string {
	return path.length > 1 ? path.replace(/[\\/]+$/u, "") : path;
}
