import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memory.ts";
import { harness, problem } from "./support/harness.ts";

/** A store whose repository lookups blow up, to exercise the error handler. */
class BrokenStore extends MemoryStore {
  override findRepo(): never {
    throw new Error("disk on fire: /var/lib/forge");
  }
}

describe("error responses", () => {
  it("are problem+json documents with type, title, status and detail", async () => {
    const h = harness();
    const res = await h.anonymous.get("/users/nobody");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "user nobody not found",
    });
  });

  it("hide the details of unexpected failures behind a 500", async () => {
    const h = harness({ store: new BrokenStore() });
    await h.signUp("alice");
    const body = await problem(await h.anonymous.get("/repos/alice/forge"), 500);
    expect(body).toEqual({
      type: "/problems/internal",
      title: "Internal Server Error",
      status: 500,
      detail: "an unexpected error occurred",
    });
  });

  it("leave unknown routes to Hono's plain-text 404, unlike a missing resource", async () => {
    const h = harness();
    const alice = await h.user("alice");
    await h.createRepo(alice, "forge");
    const route = await alice.get("/repos/alice/forge/wiki");
    expect(route.status).toBe(404);
    expect(route.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await route.text()).toBe("404 Not Found");
    const resource = await alice.get("/repos/alice/missing");
    expect(resource.headers.get("content-type")).toBe("application/problem+json");
  });
});
