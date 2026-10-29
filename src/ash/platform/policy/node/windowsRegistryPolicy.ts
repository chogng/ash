import koffi from 'koffi';
import { join } from 'node:path';
import type { IStringDictionary } from '../../../base/common/collections.js';
import type { PolicyDefinition } from '../common/policy.js';

// This host uses Koffi only for these small synchronous registry calls. Value
// buffers are passed directly, so its general-purpose 3 MiB call arena is unused.
koffi.config({ sync_stack_size: 256 * 1024, sync_heap_size: 64 * 1024 });

// Only the system DLL and read-only APIs are exposed at this native boundary.
const registry = koffi.load(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'advapi32.dll'));
const openKey = registry.func(
	'int32_t __stdcall RegOpenKeyExW(void *key, const char16_t *path, uint32_t options, uint32_t access, _Out_ void **result)',
);
const queryValue = registry.func(
	'int32_t __stdcall RegQueryValueExW(void *key, const char16_t *name, void *reserved, _Out_ uint32_t *type, _Out_ uint8_t *data, _Inout_ uint32_t *size)',
);
const closeKey = registry.func('int32_t __stdcall RegCloseKey(void *key)');
const missing = 2;
const moreData = 234;
const maximumValueBytes = 2 * 1024 * 1024 + 2;

/** Read one complete snapshot. The service owns polling, recovery and publication. */
export function readWindowsRegistryPolicies(
	definitions: IStringDictionary<PolicyDefinition>,
	location: { readonly hive: 'machine' | 'user'; readonly path: string } = {
		hive: 'machine',
		path: 'SOFTWARE\\Policies\\Ash',
	},
): IStringDictionary<unknown> {
	const root = BigInt.asUintN(
		process.arch === 'ia32' ? 32 : 64,
		location.hive === 'machine' ? -2147483646n : -2147483647n,
	);
	const handle: [bigint | null] = [null];
	// Match the existing 64-bit Windows PowerShell registry view.
	const opened = openKey(root, location.path, 0, 0x101, handle);
	if (opened === missing) return {};
	checkStatus(opened, 'open policy key');
	const values: Record<string, unknown> = {};
	let snapshotBytes = 0;
	try {
		for (const [name, definition] of Object.entries(definitions)) {
			const type = [0];
			const size = [0];
			let status = queryValue(handle[0], name, null, type, null, size);
			if (status === missing) continue;
			if (status !== moreData) checkStatus(status, `size policy ${name}`);
			// A concurrent writer may resize a value between the size and data reads.
			// Bound both allocation and retries; failed snapshots retain the last values.
			let data: Buffer | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (size[0]! > maximumValueBytes) throw new TypeError(`Policy value too large: ${name}`);
				if (snapshotBytes + size[0]! > 4 * 1024 * 1024)
					throw new TypeError('Registry policy snapshot too large');
				data = Buffer.alloc(size[0]!);
				status = queryValue(handle[0], name, null, type, data, size);
				if (status !== moreData) break;
			}
			if (status === missing) continue;
			checkStatus(status, `read policy ${name}`);
			snapshotBytes += size[0]!;
			const bytes = data!.subarray(0, size[0]);
			let value: unknown;
			if (type[0] === 1 && bytes.length % 2 === 0) {
				value = bytes.toString('utf16le').replace(/\0$/u, '');
			} else if (type[0] === 4 && bytes.length === 4) {
				const number = bytes.readInt32LE();
				value = definition.type === 'boolean' && (number === 0 || number === 1) ? number === 1 : number;
			} else if (type[0] === 11 && bytes.length === 8) {
				value = Number(bytes.readBigInt64LE());
			} else {
				throw new TypeError(`Unsupported registry policy kind: ${name}`);
			}
			Object.defineProperty(values, name, { value, enumerable: true });
		}
		return values;
	} finally {
		closeKey(handle[0]);
	}
}

function checkStatus(status: number, operation: string): void {
	if (status !== 0) throw new Error(`Could not ${operation} (Windows error ${status})`);
}
