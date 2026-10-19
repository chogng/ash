import { createTreeSitterSyntaxSession } from '../../src/ash/workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { TreeSitterSyntaxTokenBackend } from '../../extensions/code/browser/model/tokens/treeSitter/treeSitterSyntaxTokenBackend.js';

/** Composes the real host session adapter with the package-owned renderer cache. */
export function createTestSyntaxBackend(...args: Parameters<typeof createTreeSitterSyntaxSession>) {
    const source = createTreeSitterSyntaxSession(...args);
    return source ? new TreeSitterSyntaxTokenBackend(args[0], source.session, source.resolveStyle, source.measure) : undefined;
}
