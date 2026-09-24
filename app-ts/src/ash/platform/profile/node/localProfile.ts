import { constants } from "node:fs";
import { access, copyFile, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface LegacyLocalProfileMigrationOptions {
	readonly legacyUserDataRoot: string;
	readonly profileRoot: string;
}

/** Copies legacy Desktop resources only when their canonical destination does not exist. */
export async function migrateLegacyLocalProfile(options: LegacyLocalProfileMigrationOptions): Promise<void> {
	await mkdir(options.profileRoot, { recursive: true });
	await copyFileIfMissing(join(options.legacyUserDataRoot, "configuration.json"), join(options.profileRoot, "configuration.json"));
	await copyFileIfMissing(join(options.legacyUserDataRoot, "keybindings.json"), join(options.profileRoot, "keybindings.json"));
	await copyFileIfMissing(join(options.legacyUserDataRoot, "keyboard-layout.json"), join(options.profileRoot, "keyboard-layout.json"));
	await copyDirectoryIfMissing(join(options.legacyUserDataRoot, "themes"), join(options.profileRoot, "themes"));
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
