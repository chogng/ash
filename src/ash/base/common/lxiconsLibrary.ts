import { createProductIconLibrary } from "./productIcons.js";
import { registerLxicon } from './lxiconsUtil.js';

/**
 * Lxicons supplied by Ash's repository-owned product resources.
 *
 * The generated library gives every canonical SVG the ID derived from its
 * lowercase kebab-case filename.
 */
export const lxiconsLibrary = createProductIconLibrary(registerLxicon);
