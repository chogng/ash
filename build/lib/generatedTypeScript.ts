import { resolve } from 'node:path';
import { format } from '../format.ts';

const repository = resolve(import.meta.dirname, '../..');

/** Generated destinations may be ignored build artifacts; their emitted source still uses the repository rules. */
export function formatGeneratedTypeScript(source: string): string {
	return format(resolve(repository, 'build/generatedSource.ts'), source);
}
