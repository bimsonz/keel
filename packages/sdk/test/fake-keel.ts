import { createKeelClient } from "../src/index.ts";

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A fake Keel: answers the token endpoint and then whatever `respond` scripts, recording every request. */
export function fakeKeel(respond: (request: Sent, call: number) => Response) {
  const sent: Sent[] = [];
  let tokens = 0;
  let calls = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request: Sent = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    sent.push(request);
    if (url.endsWith("/v1/oauth/token")) {
      tokens += 1;
      return Response.json({
        access_token: `token-${tokens}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "agent:work",
      });
    }
    calls += 1;
    return respond(request, calls);
  };
  const client = createKeelClient({
    baseUrl: "https://keel.test/",
    clientId: "client-a",
    clientSecret: "secret-a",
    fetch,
  });
  return { client, sent, tokens: () => tokens };
}
