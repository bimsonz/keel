import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import { decodeExit, encodeExit, exitCodec } from "../../src/rpc/exit.ts";

/** The schema, writing down each property read from it: building a codec reads its schemas. */
const watched = <S extends object>(schema: S, reads: PropertyKey[]): S =>
  new Proxy(schema, {
    get: (target, key) => {
      reads.push(key);
      return Reflect.get(target, key);
    },
  });

describe("the RPC maps' Exit codecs", () => {
  it("[rpc.exit-codec-lazy] reads nothing of its schemas until first used, then is built once", () => {
    const reads: PropertyKey[] = [];
    const codec = exitCodec(watched(Schema.String, reads), Schema.Never);
    expect(reads).toEqual([]);
    const built = codec();
    expect(reads.length).toBeGreaterThan(0);
    const after = reads.length;
    expect(codec()).toBe(built);
    expect(reads).toHaveLength(after);
    expect(decodeExit(codec, encodeExit(codec, Exit.succeed("ok")))).toEqual(Exit.succeed("ok"));
  });
});
