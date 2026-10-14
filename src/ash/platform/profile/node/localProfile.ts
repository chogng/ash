import { constants } from "node:fs";
import { access, copyFile, cp, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonc } from "../../../base/common/jsonc.js";
import { equals } from "../../../base/common/objects.js";
import { ConfigurationModelParser } from '../../configuration/common/configurationModels.js';
import { NullLoggerService } from '../../log/common/log.js';

export interface LegacyLocalProfileMigrationOptions {
	readonly legacyUserDataRoot: string;
	readonly profileRoot: string;
}

export interface LocalProfileMigrationConflict {
	readonly legacyPath: string;
	readonly settingsPath: string;
}

/** Copies legacy Desktop resources only when their canonical destination does not exist. */
export async function migrateLegacyLocalProfile(options: LegacyLocalProfileMigrationOptions): Promise<LocalProfileMigrationConflict | undefined> {
	await mkdir(options.profileRoot, { recursive: true });
	const settingsPath = join(options.profileRoot, "settings.json");
	await copyFileIfMissing(join(options.legacyUserDataRoot, "settings.json"), settingsPath);
	if (!await pathExists(settingsPath)) {
		await copyFileIfMissing(join(options.legacyUserDataRoot, "configuration.json"), join(options.profileRoot, "configuration.json"));
	}
	const conflict = await migrateLegacyConfiguration(options.profileRoot);
	await copyFileIfMissing(join(options.legacyUserDataRoot, "keybindings.json"), join(options.profileRoot, "keybindings.json"));
	await copyFileIfMissing(join(options.legacyUserDataRoot, "keyboard-layout.json"), join(options.profileRoot, "keyboard-layout.json"));
	await copyDirectoryIfMissing(join(options.legacyUserDataRoot, "themes"), join(options.profileRoot, "themes"));
	return conflict;
}

/** Moves the old configuration envelope into the profile's plain JSONC settings resource. */
export async function migrateLegacyConfiguration(profileRoot: string): Promise<LocalProfileMigrationConflict | undefined> {
	const legacyPath = join(profileRoot, "configuration.json");
	const targetPath = join(profileRoot, "settings.json");
	let legacySource: string;
	try {
		const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>;
		if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || Object.keys(legacy).sort().join(',') !== 'source,version' || legacy.version !== 1 || typeof legacy.source !== 'string') {
			throw new TypeError('Invalid legacy configuration document');
		}
		legacySource = validateSettingsSource(legacy.source);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}

	let targetSource: string | undefined;
	try {
		targetSource = await readFile(targetPath, "utf8");
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	if (targetSource === undefined) {
		const temporaryPath = `${targetPath}.${process.pid}.migration`;
		await writeFile(temporaryPath, legacySource, "utf8");
		try {
			await link(temporaryPath, targetPath);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		} finally {
			await unlink(temporaryPath);
		}
		targetSource = await readFile(targetPath, "utf8");
	}
	const target = validateSettingsSource(targetSource);
	if (!equals(parseJsonc(legacySource, "legacy configuration"), parseJsonc(target, "settings"))) {
		return { legacyPath, settingsPath: targetPath };
	}
	await unlink(legacyPath);
	return undefined;
}

function validateSettingsSource(source: string): string {
	const parser = new ConfigurationModelParser('settings migration', new NullLoggerService());
	parser.parse(source);
	if (parser.errors.length) throw new TypeError(`Settings JSONC is invalid: ${parser.errors[0]!.message}`);
	return source;
}

async function copyFileIfMissing(source: string, destination: string): Promise<void> {
	try {
		await copyFile(source, destination, constants.COPYFILE_EXCL);
	} catch (error) {
		if (!isMissingOrExistingPathError(error)) throw error;
	}
}

async function copyDirectoryIfMissing(source: string, destination: string): Promise<void> {
	if (await pathExists(destination) || !await pathExists(source)) return;
	await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isMissingOrExistingPathError(error: unknown): boolean {
	return isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
