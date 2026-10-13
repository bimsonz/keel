import { describe, expect, it } from "vitest";
import app from "../src/index.ts";

const env = { GREETING: "hello from worker-lite" };

describe("worker-lite", () => {
  it("answers its health check", async () => {
    const response = await app.request("/health", {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("greets with the greeting it is configured with", async () => {
    const response = await app.request("/", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ greeting: "hello from worker-lite" });
  });
});
