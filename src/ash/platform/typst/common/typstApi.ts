import type { TypstCompileParams, TypstCompileResult } from "../../../../../.build/protocol/typescript/index.js";

export interface ITypstApi {
	compile(params: TypstCompileParams): Promise<TypstCompileResult>;
}
