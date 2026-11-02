import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function readDevelopmentAppServerGeneration(generationFile: string): Promise<string | undefined> {
	try {
		return parseDevelopmentAppServerGeneration(generationFile, await readFile(generationFile, 'utf8'));
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT' && error.path === generationFile) return undefined;
		throw error;
	}
}

export function readDevelopmentAppServerGenerationSync(generationFile: string): string | undefined {
	try {
		return parseDevelopmentAppServerGeneration(generationFile, readFileSync(generationFile, 'utf8'));
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT' && error.path === generationFile) return undefined;
		throw error;
	}
}

function parseDevelopmentAppServerGeneration(generationFile: string, contents: string): string {
	if (Buffer.byteLength(contents, 'utf8') > 4_096) throw new Error('Development runtime generation is oversized');
	const value: unknown = JSON.parse(contents);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Development runtime generation is invalid');
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(',') !== 'runtime,version' || record.version !== 3 || typeof record.runtime !== 'string' || !/^generations\/[a-f0-9]{64}$/u.test(record.runtime)) throw new Error('Development runtime generation is invalid');
	const runtime = resolve(dirname(generationFile), record.runtime);
	// This read is only a change notification. Rust validates the files while
	// holding publish.lock and returns a lease before they can be used.
	return runtime;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
