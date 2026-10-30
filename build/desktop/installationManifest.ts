import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Record final signed Windows bytes so an upgrade only reclaims obsolete owned files. */
export async function writeInstallationManifest(root: string): Promise<void> {
	const files: Record<string, string> = {};
	const manifest = 'resources/installation-files.json';
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const name = relative(root, path).replaceAll('\\', '/');
			if (name === manifest) continue;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				const digest = createHash('sha256');
				for await (const chunk of createReadStream(path)) digest.update(chunk);
				files[name] = digest.digest('hex');
			} else throw new Error(`Windows installer contains an unsupported path: ${path}`);
		}
	}
	await visit(root);
	await writeFile(join(root, manifest), JSON.stringify({ schemaVersion: 1, files }));
}
