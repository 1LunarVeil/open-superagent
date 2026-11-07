/** Stable content-derived identifiers; equal inputs always produce the same id. */
import { createHash } from 'node:crypto';
export function key(...values) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
}
