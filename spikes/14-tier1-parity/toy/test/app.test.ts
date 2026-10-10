import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { ItemStore } from "../src/store";

describe("items api", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp(new ItemStore());
  });

  it("reports health", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates an item", async () => {
    const res = await app.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "bolt", qty: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 1, name: "bolt", qty: 3 });
  });

  it.each([
    [{ qty: 1 }, 400],
    [{ name: "", qty: 1 }, 400],
    [{ name: "nut", qty: -1 }, 400],
    [{ name: "nut", qty: 2.5 }, 400],
  ])("rejects %j with %i", async (body, status) => {
    const res = await app.request("/items", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(status);
  });

  describe("by id", () => {
    beforeEach(async () => {
      await app.request("/items", { method: "POST", body: JSON.stringify({ name: "washer" }) });
    });
    it("gets an item", async () => {
      const res = await app.request("/items/1");
      expect(await res.json()).toStrictEqual({ id: 1, name: "washer", qty: 1 });
    });
    it("404s on a missing item", async () => {
      const res = await app.request("/items/99");
      expect(res.status).toBe(404);
    });
    it("deletes an item", async () => {
      expect((await app.request("/items/1", { method: "DELETE" })).status).toBe(204);
      expect((await app.request("/items")).json()).resolves.toHaveLength(0);
      await expect((await app.request("/items")).json()).resolves.toEqual([]);
    });
  });

  // Intentional failure: the API returns 404, not 410.
  it("returns 410 for deleted items", async () => {
    const res = await app.request("/items/5", { method: "DELETE" });
    expect(res.status).toBe(410);
  });
});
