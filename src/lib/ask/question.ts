// The length a question may have after trimming, shared by the handler, the sender, the OpenAPI
// document, the Ask box and the build's numbers. No imports, so scripts/build-db.ts can read it
// without the SDK.
export const QUESTION_LENGTH = { min: 3, max: 200 } as const;
