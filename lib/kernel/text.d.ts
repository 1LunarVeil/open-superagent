/** Small text helpers shared by policy and sources (inlined from upstream `infra/text.ts`). */
/** Case-insensitive name comparison used for sender allowlists and bot lists across Sources. */
export declare const sameName: (a: string, b: string) => boolean;
/** Escapes a string for literal use inside a regular expression. */
export declare const escapeRegExp: (value: string) => string;
