/** Provider-delivered managed values. The configuration registry declares their UI meanings. */
export interface IPolicyData {
	readonly managedSettings?: Readonly<Record<string, string | number | boolean>>;
}
