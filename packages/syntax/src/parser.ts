/**
 * Boots tree-sitter's TypeScript parser from two compiled Wasm modules and
 * parses one file at a time inside two budgets, because the text is a
 * stranger's and the parser runs beside credentials.
 *
 * **Memory.** The runtime gets 32 MB and may grow to 64 MB, no further. A
 * hostile file (16 KB of unclosed generic calls is enough) otherwise grows
 * the heap past a Worker's whole allowance within a second, and nothing the
 * parser reports on the way can stop it. Past the cap the runtime aborts,
 * which is an exception here: the file is `unparseable`, the dead runtime is
 * dropped, and the next boot makes a new one in a few milliseconds.
 *
 * **Work.** tree-sitter calls back every hundred or so parse operations, and
 * a file is given up as `too-slow` once the calls pass `parseBudget`. It is a
 * count and not a clock because a Worker's clock stands still while it
 * computes.
 *
 * Module scope holds only a parser that has finished booting, never a pending
 * promise: a promise made in one Workers request and awaited from another can
 * wait for ever. The runtime is one per isolate, so a boot asked for while
 * another is under way is refused (`ParserStarting`) rather than raced; the
 * caller tries again.
 */
import type { Node } from "web-tree-sitter";
import { PARSER_PACKAGES } from "./generated/versions.ts";
import { discardRuntime, Language, Parser } from "./generated/web-tree-sitter.js";

/** The rules that read a tree, then the parser's packages: what a derivation record is stamped with. */
export const PARSER_VERSION = `keel-syntax/1 ${PARSER_PACKAGES}`;

/** The runtime (`web-tree-sitter.wasm`) and the grammar (`tree-sitter-typescript.wasm`), compiled. */
export interface SyntaxWasm {
  readonly runtime: WebAssembly.Module;
  readonly grammar: WebAssembly.Module;
}

/** The runtime's heap in 64 KiB pages: what it starts with, and the most it may ever hold. */
export const HEAP_PAGES = { initial: 512, maximum: 1024 };

/**
 * How many progress calls one file may take. Source as people write it takes
 * about one call per 80 bytes (the densest file measured in this repo: one
 * per 83); the budget allows one per 32, and 2,000 for any file however small.
 */
export const parseBudget = (bytes: number): number => 2_000 + Math.ceil(bytes / 32);

export interface SourceParser {
  readonly version: string;
  /**
   * Parses `text` and hands the tree's root to `read`; the tree is freed when
   * `read` returns. `too-slow` when the parse passed its work budget,
   * `unparseable` when it passed the memory cap, and `restart` when this
   * parser's runtime is gone (its own file or another call's killed it): boot
   * again and read the same text.
   */
  readonly read: <T>(
    text: string,
    read: (root: Node) => T,
  ) => T | "too-slow" | "unparseable" | "restart";
}

/** Another call in this isolate is booting the parser; try again. */
export class ParserStarting extends Error {
  override readonly name = "ParserStarting";
}

let ready: Parser | undefined;
let booting = false;

/** Drops a runtime that has aborted. Its parser is unregistered first, so nothing of it is freed into the next one. */
function discard(): void {
  const dead = ready;
  ready = undefined;
  try {
    dead?.delete();
  } catch {
    // The dead runtime may refuse even this; the parser is unregistered by then.
  }
  discardRuntime();
}

export async function bootParser(wasm: SyntaxWasm): Promise<SourceParser> {
  if (ready === undefined) {
    if (booting) throw new ParserStarting("the parser is starting in this isolate");
    booting = true;
    try {
      await Parser.init({
        wasmMemory: new WebAssembly.Memory(HEAP_PAGES),
        instantiateWasm(
          imports: WebAssembly.Imports,
          done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) {
          const instance = new WebAssembly.Instance(wasm.runtime, imports);
          done(instance, wasm.runtime);
          return instance.exports;
        },
      });
      const parser = new Parser();
      parser.setLanguage(Language.loadSync(wasm.grammar));
      ready = parser;
    } catch (error) {
      discardRuntime();
      throw error;
    } finally {
      booting = false;
    }
  }
  const parser = ready;
  return {
    version: PARSER_VERSION,
    read: (text, read) => {
      if (ready !== parser) return "restart";
      const budget = parseBudget(text.length);
      let calls = 0;
      const stop = (): boolean => ++calls > budget;
      let tree;
      try {
        tree = parser.parse(text, null, { progressCallback: stop });
      } catch {
        discard();
        return "unparseable";
      }
      if (tree === null) {
        parser.reset();
        return "too-slow";
      }
      try {
        return read(tree.rootNode);
      } finally {
        tree.delete();
      }
    },
  };
}
