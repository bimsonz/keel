// Egress probe: with globalOutbound null, fetch() must throw.
import { serve } from "./common.ts";

export default serve("fetchprobe", async (_input, url) => {
  const target = url.searchParams.get("target") ?? "https://example.com/";
  try {
    const res = await fetch(target);
    return { fetched: true, status: res.status, body: (await res.text()).slice(0, 80) };
  } catch (e) {
    const err = e as Error;
    return { fetched: false, error: `${err.name}: ${err.message}` };
  }
});
