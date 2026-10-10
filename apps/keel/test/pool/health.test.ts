import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("answers /healthz through the Worker's own fetch handler", async () => {
  const response = await exports.default.fetch("https://keel.localhost/healthz");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "keel" });
});
