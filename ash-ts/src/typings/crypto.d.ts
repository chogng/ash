// Shared Web Crypto surface consumed by common code, without DOM types.
declare var crypto: {
	randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
	readonly subtle: {
		digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
	};
};
