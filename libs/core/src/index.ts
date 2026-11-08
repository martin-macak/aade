/**
 * A seed package, which real code replaces when the main application arrives.
 *
 * It imports `@aade/contracts` to give the build order, the cache and the
 * architecture rules one real dependency between packages.
 */

import { PRODUCT_NAME } from '@aade/contracts';

/** Returns the product name with its version, such as `aade 1.2.0`. */
export function describeProduct(version: string): string {
  return `${PRODUCT_NAME} ${version}`;
}
