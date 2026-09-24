import * as onigurumaNamespace from "vscode-oniguruma";
import onigurumaWasmUrl from "vscode-oniguruma/release/onig.wasm?url&no-inline";
import { type IOnigLib } from "vscode-textmate";

const onigurumaRuntime = (onigurumaNamespace as unknown as { readonly default?: typeof onigurumaNamespace }).default ?? onigurumaNamespace;
const { createOnigScanner, createOnigString, loadWASM } = onigurumaRuntime;
let onigLib: Promise<IOnigLib> | undefined;

/** Loads the browser Worker's shared Oniguruma WASM runtime exactly once. */
export function createBrowserTextMateOnigLib(): Promise<IOnigLib> {
	onigLib ??= initialize();
	return onigLib;
}

async function initialize(): Promise<IOnigLib> {
	const response = await fetch(onigurumaWasmUrl);
	if (!response.ok) throw new Error(`Unable to load Oniguruma WASM (${response.status})`);
	await loadWASM(response);
	return Object.freeze({ createOnigScanner, createOnigString });
}
