/** A path only the current routes answer one way: getChange admits anonymous reads (11adb24). */
export const FRESH_ROUTE_PATH = "/v1/changes/not-a-change";

export interface RoutesCheck {
  readonly ok: boolean;
  readonly what: string;
  readonly detail: { readonly status: number; readonly code: unknown };
}

/**
 * The deployed routes are the ones generated from the committed spec. The
 * generated routes are gitignored, so a deploy from a clone whose last
 * `pnpm gen` predates a spec change ships the old authorization: an anonymous
 * read of getChange would then answer 401 before its id is validated, where
 * the current routes let it through to the validator's 400.
 */
export async function routesSmoke(keelUrl: string): Promise<RoutesCheck> {
  const response = await fetch(`${keelUrl}${FRESH_ROUTE_PATH}`);
  let code: unknown;
  try {
    code = Reflect.get(Object(await response.json()), "code");
  } catch {
    code = undefined;
  }
  return {
    ok: response.status === 400 && code === "request.invalid",
    what: `an anonymous ${FRESH_ROUTE_PATH} reaches the validator (400), so the routes are current`,
    detail: { status: response.status, code },
  };
}
