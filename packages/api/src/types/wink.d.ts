/*
 * WHAT THIS FILE DOES
 * Hand-written TypeScript type declarations for the two `wink` packages used
 * by the BM25 keyword index. Both ship as plain JavaScript with no bundled
 * types and no @types package, so without this file `tsc` refuses to compile
 * any import of them under strict mode.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * Build-time only — this file produces no runtime code. It exists solely so
 * keywordIndex.ts can import wink-bm25-text-search with type safety.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * A `.d.ts` "ambient declaration" file is TypeScript's escape hatch for
 * untyped npm packages: you describe the shape of the library yourself and
 * the compiler trusts you. It's the same idea as writing a JSDoc block for
 * an untyped dependency, but enforced by the compiler.
 *
 * INTERVIEW TALKING POINT
 * "I only declared the subset of the wink API the project actually calls —
 * minimal ambient types are easier to keep honest than a full transcription
 * of someone else's library."
 */

declare module 'wink-bm25-text-search' {
  /**
   * One prep-task function in the text-processing pipeline (e.g. lowercase,
   * tokenize, stem). Typed loosely on purpose: the pipeline alternates between
   * string→string, string→tokens and tokens→tokens stages, and wink chains
   * whatever each stage returns into the next.
   */
  type PrepTask = (input: never) => string | string[];

  interface BM25Engine {
    /** Set per-field weights. Must be called before adding documents. */
    defineConfig(config: { fldWeights: Record<string, number> }): boolean;
    /** Register the text-processing pipeline applied to documents and queries alike. */
    definePrepTasks(tasks: PrepTask[]): number;
    /** Add one document. `uniqueId` is returned by search() to identify hits. */
    addDoc(doc: Record<string, string>, uniqueId: number): number;
    /** Finalize the index. Throws if called twice or with fewer than 3 documents. */
    consolidate(fp?: number): boolean;
    /** Returns up to `limit` results as [uniqueId, bm25Score] pairs, best first. */
    search(text: string, limit?: number): Array<[number, number]>;
  }

  function bm25(): BM25Engine;
  export = bm25;
}

declare module 'wink-nlp-utils' {
  type StringTask = (input: string) => string;
  type TokenizeTask = (input: string) => string[];
  type TokensTask = (input: string[]) => string[];

  const nlp: {
    string: {
      lowerCase: StringTask;
      removeExtraSpaces: StringTask;
      /** Basic whitespace/punctuation tokenizer: string in, array of tokens out. */
      tokenize0: TokenizeTask;
    };
    tokens: {
      /** Drops English stop words ("the", "of", "is", …). */
      removeWords: TokensTask;
      /** Porter stemmer: reduces words to their root ("funding" → "fund"). */
      stem: TokensTask;
      propagateNegations: TokensTask;
    };
  };
  export = nlp;
}
