import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ID_OUTPUT,
  CLIENT_SECRET_BINDING,
  oauthClientAtDeploy,
} from "../../../scripts/lib/oauth-client.ts";

const keelConfig: unknown = parse(
  readFileSync(new URL("../../../apps/keel/wrangler.jsonc", import.meta.url), "utf8"),
);
const OUTPUTS = new Map([["secrets_store_id", "store"]]);

describe("an instance's OAuth client at deploy", () => {
  it("[deploy.oauth-optional] with no client in Terraform, keel deploys without the secret's binding and says so", () => {
    const decided = oauthClientAtDeploy(keelConfig, OUTPUTS);
    expect(decided.kind).toBe("unregistered");
    if (decided.kind !== "unregistered") return;
    const secrets: unknown =
      typeof keelConfig === "object" && keelConfig !== null
        ? Reflect.get(keelConfig, "secrets_store_secrets")
        : undefined;
    expect(Array.isArray(secrets) && decided.dropSecretAt !== undefined).toBe(true);
    expect(
      Array.isArray(secrets)
        ? Reflect.get(secrets[decided.dropSecretAt ?? -1] ?? {}, "binding")
        : "",
    ).toBe(CLIENT_SECRET_BINDING);
    expect(decided.said).toContain(CLIENT_ID_OUTPUT);
  });

  it("[deploy.oauth-registered] with Terraform's client, keel gets its id and keeps the binding", () => {
    expect(
      oauthClientAtDeploy(keelConfig, new Map([...OUTPUTS, [CLIENT_ID_OUTPUT, "client-1"]])),
    ).toEqual({ kind: "registered", clientId: "client-1" });
    expect(oauthClientAtDeploy({ vars: { KEEL_HOST: "h" } }, OUTPUTS)).toEqual({ kind: "none" });
  });
});
