/**
 * The parser's runtime is one per isolate. These run in a file of their own,
 * so the first boot here is this process's first.
 */
import { describe, expect, it } from "vitest";
import { bootParser, ParserStarting } from "../src/index.ts";
import { WASM } from "./support/parser.ts";

/** 16 KB that grows the parser's heap past its cap. */
const HOSTILE = `f(${"a<b,".repeat(4096)}`;
const kinds = (root: { readonly namedChildren: readonly { readonly type: string }[] }) =>
  root.namedChildren.map((child) => child.type);

describe("the parser's one runtime", () => {
  it("[syntax.one-boot] a boot asked for while another is under way is refused, never raced, and the next one is given the parser the first made", async () => {
    const first = bootParser(WASM);
    const second = bootParser(WASM);
    await expect(second).rejects.toBeInstanceOf(ParserStarting);
    const parser = await first;
    expect(parser.read("const a = 1;\n", kinds)).toEqual(["lexical_declaration"]);
    const third = await bootParser(WASM);
    expect(third.read("f();\n", kinds)).toEqual(["expression_statement"]);
    expect(third.version).toMatch(
      /^keel-syntax\/1 web-tree-sitter@\S+ tree-sitter-typescript@\S+$/,
    );
  });

  it("[syntax.stale-parser] a parser whose runtime another call's file has killed says so, and reads nothing on the new runtime's memory", async () => {
    const mine = await bootParser(WASM);
    const theirs = await bootParser(WASM);
    expect(theirs.read(HOSTILE, kinds)).toBe("unparseable");
    expect(mine.read("const a = 1;\n", kinds)).toBe("restart");
    expect(theirs.read("const a = 1;\n", kinds)).toBe("restart");
    const again = await bootParser(WASM);
    expect(again.read("const a = 1;\n", kinds)).toEqual(["lexical_declaration"]);
    // The old handle stays stale after the new runtime is up.
    expect(mine.read("const a = 1;\n", kinds)).toBe("restart");
  });
});
