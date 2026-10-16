import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateTreeSitterRegistry, grammarResource, readGrammarPackages } from './treeSitterRegistry.ts';
import { splitTreeSitterLexer } from './treeSitterLexer.ts';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
interface CargoPackage { name: string; version: string; manifest_path: string; }
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function resource(directory: string, value: string): string {
	if (typeof value !== 'string' || isAbsolute(value)) throw new TypeError('Grammar resource paths must be relative');
	const path = resolve(directory, value);
	if (relative(directory, path).split(sep).includes('..')) throw new RangeError('Grammar resource escapes its language package');
	return path;
}

/** Verify checked-in portable assets, or rebuild them from Cargo.lock's exact grammar sources. */
export async function verifyTreeSitterGrammars(args: readonly string[] = ['--verify']): Promise<void> {
	const rebuild = args[0] === '--build';
	if (args.length < 1 || args.length > 2 || !['--verify', '--build'].includes(args[0]!)) throw new Error('Usage: node build/treeSitter.ts --verify|--build [grammar]');
	const metadata: { packages: CargoPackage[]; } | undefined = rebuild
		? JSON.parse((await execute('cargo', ['metadata', '--locked', '--format-version=1'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout)
		: undefined;
	let count = 0;
	await generateTreeSitterRegistry({ check: true });
	for (const { directory: packageName, manifest, grammars } of await readGrammarPackages()) {
		for (const grammar of grammars) {
			if (args[1] && grammar.name !== args[1]) continue;
			if (grammar.wasm.package) {
				if (rebuild && args[1]) throw new Error(`${grammar.name} is supplied by the locked ${grammar.wasm.package} dependency`);
				await stat(resolve(root, 'node_modules', grammar.wasm.package));
				count++;
				continue;
			}
			const output = grammarResource(root, packageName, grammar.wasm.path!);
			if (rebuild) {
				const source = metadata!.packages.find(item => item.name === grammar.source.crate && item.version === grammar.source.version);
				if (!source) throw new Error(`Cargo.lock does not contain ${grammar.source.crate}@${grammar.source.version}`);
				const sourceRoot = resource(dirname(source.manifest_path), grammar.source.root);
				if (grammar.wasm.splitLexer || grammar.wasm.libc?.length) {
					const compiler = process.env.ASH_WASI_CC;
					if (!compiler) throw new Error('ASH_WASI_CC must point to wasi-sdk-29/bin/clang for this grammar');
					const staging = await mkdtemp(resolve(tmpdir(), 'ash-tree-sitter-'));
					try {
						await cp(resolve(sourceRoot, 'src'), resolve(staging, 'src'), { recursive: true });
						const parser = resolve(staging, 'src/parser.c');
						if (grammar.wasm.splitLexer) await writeFile(parser, splitTreeSitterLexer(await readFile(parser, 'utf8')));
						const inputs = ['parser.c'];
						try { await stat(resolve(staging, 'src/scanner.c')); inputs.push('scanner.c'); }
						catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
						for (const symbol of grammar.wasm.libc ?? []) {
							if (!/^[a-z][a-z0-9_]*$/.test(symbol)) throw new TypeError('Invalid WASI support symbol');
							const archive = (await execute(compiler, ['-print-file-name=libc.a'])).stdout.trim();
							const object = await execute(resolve(dirname(compiler), 'llvm-ar'), ['p', archive, symbol + '.o'], { encoding: 'buffer' });
							await writeFile(resolve(staging, 'src', symbol + '.o'), object.stdout);
							inputs.push(symbol + '.o');
						}
						await execute(compiler, ['-o', output, '-fPIC', '-shared', '-Os', `-Wl,--export=tree_sitter_${grammar.name.replaceAll('-', '_')}`, '-Wl,--allow-undefined', '-Wl,--no-entry', '-nostdlib', '-fno-exceptions', '-fvisibility=hidden', '-I', '.', ...inputs], { cwd: resolve(staging, 'src') });
					} finally { await rm(staging, { recursive: true, force: true }); }
				} else {
					await execute(process.env.ASH_TREE_SITTER_CLI ?? 'tree-sitter', ['build', '--wasm', '--output', output, sourceRoot], { cwd: sourceRoot });
				}
				grammar.wasm.sha256 = hash(await readFile(output));
			}
			if ((await stat(output)).size > 16 * 1024 * 1024 || hash(await readFile(output)) !== grammar.wasm.sha256) throw new Error(`Grammar asset digest mismatch: ${output}`);
			count++;
		}
		if (rebuild) await writeFile(manifest, JSON.stringify(grammars, null, 2) + '\n');
	}
	if (!count) throw new Error('No packaged Tree-sitter grammars found');
	console.log(`Verified ${count} bundled Tree-sitter grammars`);
}

if (import.meta.main) { await verifyTreeSitterGrammars(process.argv.slice(2)); }
