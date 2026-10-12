import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { describe, expect, it } from "vitest";

describe("the retention cron", () => {
  it("[purge.cron] the Worker's config fires its scheduled handler every ten minutes", () => {
    const errors: ParseError[] = [];
    const config: unknown = parse(
      readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8"),
      errors,
      { allowTrailingComma: true },
    );
    expect(errors).toEqual([]);
    expect(config).toMatchObject({ triggers: { crons: ["*/10 * * * *"] } });
  });
});
