/**
 * Only the `bun:test` module declarations. The full `bun` types replace Node globals
 * (`ReadableStream`, `fetch`) and break type checking of the Node packages these tests import.
 */
/// <reference path="../../../../node_modules/bun-types/test.d.ts" />
