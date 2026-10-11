import { describe, expect, it } from "vitest";
import { redact } from "../../../src/application/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~+/=-";
const tokenBody = fc
  .array(fc.constantFrom(...TOKEN_CHARS.split("")), { minLength: 8, maxLength: 60 })
  .map((cs) => cs.join(""));
const hex = (n: number) =>
  fc
    .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: n, maxLength: n })
    .map((cs) => cs.join(""));

/** Every credential shape Keel redacts, as it appears in logs. */
const secret = fc.oneof(
  fc
    .tuple(tokenBody, fc.option(fc.integer({ min: 1, max: 2_000_000_000 }), { nil: undefined }))
    .map(
      ([body, expires]) => `art_v1_${body}${expires === undefined ? "" : `?expires=${expires}`}`,
    ),
  fc
    .tuple(tokenBody, fc.integer({ min: 1, max: 2_000_000_000 }))
    .map(([body, expires]) => `art_v2_x_${body}?expires=${expires}`),
  fc
    .tuple(hex(32), fc.constantFrom("keel-ws-00", "keel-core"))
    .map(([account, ns]) => `https://${account}.artifacts.cloudflare.net/git/${ns}/repo.git`),
  hex(32).map((account) => `${account}.artifacts.cloudflare.net`),
);

/** Log text around a secret: anything printable, including quotes and JSON punctuation. */
const noise = fc.string({
  unit: fc.constantFrom(..." abc:{}\"'\n\t=/?&,[]()<>xyz019".split("")),
  maxLength: 40,
});

const LEAKS = [/art_v\d+_/, /expires=(?!\[REDACTED\])/, /artifacts\.cloudflare\.net/];

describe("redaction", () => {
  it("[redact.tokens] removes every token, expiry and remote, wherever it sits in the text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(noise, secret), { minLength: 1, maxLength: 4 }),
        noise,
        (parts, end) => {
          const text = parts.map(([n, s]) => `${n}${s}`).join("") + end;
          const out = redact(text);
          for (const leak of LEAKS) expect(out).not.toMatch(leak);
          for (const [, s] of parts) expect(out).not.toContain(s);
        },
      ),
    );
  });

  it("[redact.literals] removes a known secret value, such as the account id, wherever it appears", () => {
    fc.assert(
      fc.property(hex(32), noise, noise, (account, before, after) => {
        const out = redact(`${before}${account}${after}${account}`, { literals: [account] });
        expect(out).not.toContain(account);
      }),
    );
  });

  it("[redact.preserves] leaves text without a credential shape untouched", () => {
    fc.assert(
      fc.property(noise, (text) => {
        expect(redact(text)).toBe(text);
      }),
    );
  });

  it("redacts the shapes seen on 10 Oct exactly", () => {
    expect(
      redact(
        "fetch https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/keel-ws-00/wsp_1.git token art_v2_x_abcDEF123.xyz?expires=1760140800 done",
      ),
    ).toBe("fetch [REDACTED:remote] token [REDACTED:token]?expires=[REDACTED] done");
  });

  // CI's counterexample to [redact.tokens] (seed 1744722712), pinned.
  it("[redact.glued] redacts a token with a host or remote glued to its end", () => {
    const host = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
    expect(redact(`art_v1_AAAAAAAA${host}`)).toBe("[REDACTED:token]");
    expect(redact(`art_v1_AAAAAAAAhttps://${host}/git/keel-core/r.git`)).toBe(
      "[REDACTED:token]://[REDACTED:host]/git/keel-core/r.git",
    );
  });
});
