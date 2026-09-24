import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';

export interface HomeOptions {
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly userHome: string;
}

/** Node startup adapter for the path contract owned by ash-rs/utils/home-dir. */
export function resolveHome(options: HomeOptions = { environment: process.env, userHome: homedir() }): string {
	if (options.environment.ASH_PROFILE_ROOT !== undefined) {
		throw new Error('ASH_PROFILE_ROOT has been replaced by ASH_HOME; remove ASH_PROFILE_ROOT and set ASH_HOME to the same absolute directory to retain your data');
	}
	const configured = options.environment.ASH_HOME;
	if (configured === undefined && (!options.userHome || !isAbsoluteDirectory(options.userHome))) {
		throw new Error('Could not find an absolute user home directory; set ASH_HOME');
	}
	const path = configured ?? join(options.userHome, '.ash');
	if (!path || !isAbsoluteDirectory(path)) {
		throw new Error('ASH_HOME must be a non-empty absolute directory path');
	}
	return canonicalDirectory(path);
}

function isAbsoluteDirectory(path: string): boolean {
	// A Windows root-relative path still depends on the process's current drive.
	return isAbsolute(path) && (process.platform !== 'win32' || parse(path).root.length > 1);
}

function canonicalDirectory(path: string): string {
	try {
		if (!statSync(path).isDirectory()) {
			throw new Error(`ASH_HOME is not a directory: ${path}`);
		}
		return realpathSync.native(path);
	} catch (error) {
		if (!isMissing(error)) {
			throw error;
		}
		try {
			lstatSync(path);
		} catch (linkError) {
			if (!isMissing(linkError)) {
				throw linkError;
			}
			const parent = dirname(path);
			const name = basename(path);
			if (parent === path || name === '..' || name === '.') {
				throw error;
			}
			return join(canonicalDirectory(parent), name);
		}
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
