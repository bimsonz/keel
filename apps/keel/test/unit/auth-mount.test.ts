import { describe, expect, it } from "vitest";
import { oneCredential } from "../../src/adapters/driving/http/auth-mount.ts";
import { SESSION_COOKIE } from "../../src/adapters/driving/http/gate.ts";

const URL = "https://keel.test/v1/auth/organization/create";

const asked = (headers: Record<string, string>, body?: string) =>
  new Request(URL, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });

describe("one credential a request, at Better Auth's mount", () => {
  it("[mount.one-credential] a request with an Authorization header loses its session cookie and keeps every other", async () => {
    const both = oneCredential(
      asked(
        {
          authorization: "Bearer session-token",
          cookie: `theme=dark; ${SESSION_COOKIE}=other.signature; __Secure-keel.better-auth-passkey=challenge`,
          "content-type": "application/json",
        },
        `{"name":"oak"}`,
      ),
    );
    expect(both.headers.get("cookie")).toBe(
      "theme=dark; __Secure-keel.better-auth-passkey=challenge",
    );
    expect(both.headers.get("authorization")).toBe("Bearer session-token");
    expect([both.method, both.url, both.headers.get("content-type"), await both.text()]).toEqual([
      "POST",
      URL,
      "application/json",
      `{"name":"oak"}`,
    ]);

    // The session cookie alone: no cookie header is left to read.
    const only = oneCredential(
      asked({ authorization: "Bearer session-token", cookie: `${SESSION_COOKIE}=other.signature` }),
    );
    expect(only.headers.has("cookie")).toBe(false);
  });

  it("[mount.credential-any] a credential that is no bearer is still the one presented", () => {
    const basic = oneCredential(
      asked({ authorization: "Basic abc", cookie: `${SESSION_COOKIE}=other.signature; a=1` }),
    );
    expect(basic.headers.get("cookie")).toBe("a=1");
  });

  it("[mount.cookie-kept] a request with no Authorization header is handed on as it came", () => {
    const cookie = `theme=dark; ${SESSION_COOKIE}=mine.signature`;
    const request = asked({ cookie });
    expect(oneCredential(request)).toBe(request);
    expect(oneCredential(request).headers.get("cookie")).toBe(cookie);
    const bare = asked({ authorization: "Bearer session-token" });
    expect(oneCredential(bare)).toBe(bare);
  });

  it("[mount.cookie-named] only the session cookie goes: one whose name merely holds its name stays", () => {
    const cookie = `x${SESSION_COOKIE}=1; ${SESSION_COOKIE}s=2; not=${SESSION_COOKIE}=3`;
    const kept = oneCredential(asked({ authorization: "Bearer session-token", cookie }));
    expect(kept.headers.get("cookie")).toBe(cookie);
  });
});
