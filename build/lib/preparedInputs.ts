import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Content receipts survive pnpm lifecycle processes; missing outputs invalidate them. */
export class PreparedInputs {
	private readonly receipt: string;
	private pending: Promise<boolean> | undefined;

	constructor(receipt: string) { this.receipt = receipt; }

	prepare(inputs: () => Promise<string>, outputs: () => Promise<string>, generate: () => Promise<boolean>): Promise<boolean> {
		// Vite runs buildStart hooks concurrently. Share preparation until it settles.
		return this.pending ??= this.run(inputs, outputs, generate).finally(() => { this.pending = undefined; });
	}

	private async run(inputs: () => Promise<string>, outputs: () => Promise<string>, generate: () => Promise<boolean>): Promise<boolean> {
		const input = await inputs();
		const output = await outputs();
		const receipt = await readJsonCache(this.receipt);
		if (receipt?.input === input && receipt?.output === output) { return false; }
		const changed = await generate();
		// Never certify outputs against inputs that changed while the generator ran.
		if (await inputs() === input) { await writeJsonCache(this.receipt, { input, output: await outputs() }); }
		return changed;
	}
}

/** Include paths as well as bytes, so additions, deletions and renames invalidate. */
export async function fingerprintPaths(paths: readonly string[], accepts: (path: string, directory: boolean) => boolean = () => true): Promise<string> {
	const hash = createHash('sha256');
	const files: string[] = [];
	async function visit(path: string): Promise<void> {
		let metadata;
		try { metadata = await stat(path); }
		catch (error) {
			if (error.code !== 'ENOENT') { throw error; }
			hash.update(JSON.stringify([path, 'missing']));
			return;
		}
		if (!accepts(path, metadata.isDirectory())) { return; }
		if (metadata.isDirectory()) {
			hash.update(JSON.stringify([path, 'directory']));
			// Match the generators' traversal and avoid following linked directory cycles.
			for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isSymbolicLink()) { await visit(resolve(path, entry.name)); }
			}
		} else if (metadata.isFile()) {
			files.push(path);
		}
	}
	for (const path of [...new Set(paths)].sort()) { await visit(path); }
	// Bound handles without serializing content reads across thousands of declarations.
	for (let offset = 0; offset < files.length; offset += 32) {
		const fingerprints = await Promise.all(files.slice(offset, offset + 32).map(async path => {
			const metadata = await stat(path, { bigint: true });
			const signature = `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
			let content = fileFingerprints.get(path);
			if (content?.signature !== signature) {
				const digest = createHash('sha256');
				for await (const bytes of createReadStream(path)) { digest.update(bytes); }
				content = { signature, digest: digest.digest('hex') };
				fileFingerprints.set(path, content);
			}
			return JSON.stringify([path, content.digest]);
		}));
		for (const fingerprint of fingerprints) { hash.update(fingerprint); }
	}
	return hash.digest('hex');
}

const fileFingerprints = new Map<string, { signature: string; digest: string; }>();

export async function readJsonCache(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, 'utf8'));
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch (error) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) { return undefined; }
		throw error;
	}
}

export async function writeJsonCache(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = path + '.' + randomUUID();
	await writeFile(temporary, JSON.stringify(value) + '\n');
	await rename(temporary, path);
}
