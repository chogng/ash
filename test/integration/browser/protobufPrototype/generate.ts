import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { models } from './model.js';

/** Called by the existing browser build, so a clean checkout needs no manual step. */
export function preparePrototypeCodec(): void {
	const directory = import.meta.dirname;
	const output = resolve(directory, 'codec.js');
	const temporary = resolve(directory, '../../../../.build/protobuf-prototype');
	mkdirSync(temporary, { recursive: true });
	const messages = Object.entries(models).map(([name, model]) => {
		const fields = model.array
			? [`repeated ${model.array} values = 1${model.array === 'uint32' ? ' [packed = true]' : ''};`]
			: [...Object.entries(model.fields!).map(([field, type], index) => `optional ${type} ${field} = ${index + 1};`), 'optional JsonObject extras = 1000;'];
		return `message ${name} {\n${fields.join('\n')}\n}`;
	});
	const schema = `syntax = "proto2";\npackage ashCodecPrototype;\n
message JsonValue { oneof kind { double number = 1; string text = 2; bool boolean = 3; bool nullValue = 4; JsonArray array = 5; JsonObject object = 6; bytes utf16 = 7; } }
message JsonArray { repeated JsonValue values = 1; }
message JsonObject { repeated JsonField fields = 1; }
message JsonField { oneof key { string name = 1; bytes utf16Name = 3; } required JsonValue value = 2; }
${messages.join('\n')}\n`;
	const require = createRequire(import.meta.url);
	const flags = ['-t', 'static-module', '-w', 'esm', '--dependency', 'protobufjs/minimal.js', '--keep-case', '--force-number', '--no-create', '--no-verify', '--no-convert', '--no-delimited', '--no-service', '--no-typeurl', '--no-comments'];
	const fingerprint = `${require('protobufjs/package.json').version}\n${require('protobufjs-cli/package.json').version}\n${JSON.stringify(flags)}\n${schema}`;
	const stamp = resolve(temporary, 'inputs.txt');
	try { if (readFileSync(stamp, 'utf8') === fingerprint && readFileSync(output, 'utf8').includes('ashCodecPrototype')) return; } catch { /* First build. */ }
	// Dev containers can mount .build on a separate volume. Stage beside the
	// published module so its atomic rename stays on the same filesystem.
	const staging = mkdtempSync(resolve(directory, '.codec-'));
	try {
		const source = resolve(staging, 'wire.proto');
		const generated = resolve(staging, 'codec.js');
		writeFileSync(source, schema);
		execFileSync(process.execPath, [require.resolve('protobufjs-cli/bin/pbjs'), ...flags, '-o', generated, source], { stdio: 'pipe' });
		// Concurrent browser builds must never import partially written JS.
		renameSync(generated, output);
		writeFileSync(resolve(temporary, 'wire.proto'), schema);
		writeFileSync(stamp, fingerprint);
	} finally { rmSync(staging, { recursive: true, force: true }); }
}
