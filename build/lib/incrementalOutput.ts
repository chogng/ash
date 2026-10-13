import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

/** TS trusts build info even after emitted files disappear; validate its complete emit inventory. */
export async function prepareIncrementalOutput(configFile: string): Promise<void> {
	const config = ts.readJsonConfigFile(configFile, ts.sys.readFile);
	const parsed = ts.parseJsonSourceFileConfigFileContent(config, ts.sys, dirname(configFile), undefined, configFile);
	if (parsed.errors.length) { throw new Error(ts.formatDiagnostics(parsed.errors, { getCanonicalFileName: path => path, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' })); }
	const infoFile = parsed.options.tsBuildInfoFile;
	const outDir = parsed.options.outDir;
	if (!infoFile || !outDir) { throw new Error(`Incremental compilation requires tsBuildInfoFile and outDir: ${configFile}`); }
	const ownedOutput = relative(dirname(configFile), outDir);
	if (!ownedOutput || isAbsolute(ownedOutput) || ownedOutput === '..' || ownedOutput.startsWith('../') || ownedOutput.startsWith('..\\')) {
		throw new Error(`Compiler outDir must stay inside the project: ${outDir}`);
	}
	let info: unknown;
	try { info = JSON.parse(await readFile(infoFile, 'utf8')); }
	catch (error) {
		if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { throw error; }
	}
	const files = info && typeof info === 'object' && 'fileNames' in info ? info.fileNames : undefined;
	if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) {
		// Without an inventory, stale tests from the old non-incremental runner (or
		// damaged metadata) cannot be distinguished from current compiler outputs.
		await rm(outDir, { recursive: true, force: true });
		await rm(infoFile, { force: true });
		return;
	}
	// Include transitive imports from the compiler's inventory, not just tsconfig roots.
	const previous = { ...parsed, fileNames: files.map(file => resolve(dirname(infoFile), file).replaceAll('\\', '/')) };
	const roots = info && typeof info === 'object' && 'root' in info ? info.root : undefined;
	const rootIds: number[] = [];
	if (Array.isArray(roots)) {
		for (const root of roots) {
			if (Number.isInteger(root) && root > 0 && root <= files.length) { rootIds.push(root); }
			else if (Array.isArray(root) && root.length === 2 && root.every(Number.isInteger) && root[0] > 0 && root[1] >= root[0] && root[1] <= files.length) {
				for (let id = root[0]; id <= root[1]; id++) { rootIds.push(id); }
			} else { rootIds.length = 0; break; }
		}
	}
	const canonical = (path: string): string => ts.sys.useCaseSensitiveFileNames ? path.replaceAll('\\', '/') : path.replaceAll('\\', '/').toLowerCase();
	const previousRoots = rootIds.map(id => canonical(previous.fileNames[id - 1]!)).sort();
	const currentRoots = parsed.fileNames.map(canonical).sort();
	if (JSON.stringify(previousRoots) !== JSON.stringify(currentRoots)) {
		// TSC leaves outputs for removed roots behind. In particular, switching test
		// scopes must not let discovery execute tests excluded by the current config.
		await rm(outDir, { recursive: true, force: true });
		await rm(infoFile, { force: true });
		return;
	}
	let complete = true;
	for (const source of previous.fileNames) {
		if (/\.d\.[cm]?ts$/.test(source)) { continue; }
		const outputs = ts.getOutputFileNames(previous, source, !ts.sys.useCaseSensitiveFileNames);
		const sourceExists = await exists(source);
		for (const output of outputs) {
			if (output === infoFile) { continue; }
			const inside = relative(outDir, output);
			if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
				throw new Error(`Compiler output escapes outDir: ${output}`);
			}
			if (!sourceExists) {
				// Deleted tests must not survive discovery as stale emitted JavaScript.
				await rm(output, { force: true });
				complete = false;
			} else if (!await exists(output)) { complete = false; }
		}
	}
	if (!complete) { await rm(infoFile, { force: true }); }
}

async function exists(path: string): Promise<boolean> {
	try { return (await stat(path)).isFile(); }
	catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
