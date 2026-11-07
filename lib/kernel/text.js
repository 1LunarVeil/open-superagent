/** Small text helpers shared by policy and sources (inlined from upstream `infra/text.ts`). */
/** Case-insensitive name comparison used for sender allowlists and bot lists across Sources. */
export const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
/** Escapes a string for literal use inside a regular expression. */
export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
