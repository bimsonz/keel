import { ContentHash, OrgId } from "@keeltown/core/kernel";
import { BUNDLE_URL_TTL_SECONDS, signedBundleUrl } from "@keeltown/runner-protocol";
import { Schema } from "effect";
import { KEEL_BUNDLE_PROVIDER } from "../../../rpc/index.ts";
import type {
  SourceControlAdapter,
  SourceControlCheckout,
  SourceControlProvider,
  SourceControlSource,
} from "./ci.js";

const ProviderData = Schema.Struct({ namespace: OrgId, bundle: ContentHash });

/** The one secret a checkout needs from keel's env: the key bundle URLs are signed with. */
const SigningEnv = Schema.Struct({ BUNDLE_URL_SIGNING_KEY: Schema.NonEmptyString });

/**
 * Every checkout Keel hands a runner: the namespace's bundle on the virtual
 * bundle host, at a URL signed for exactly that bundle and good, from `now`
 * (unix seconds), for a step's life. Provider data naming no namespace is
 * refused.
 */
export const checkoutOf = async (
  source: SourceControlSource,
  signingKey: string,
  now: number,
): Promise<SourceControlCheckout> => {
  const { namespace, bundle } = Schema.decodeUnknownSync(ProviderData)(source.providerData);
  return {
    kind: "archive",
    url: await signedBundleUrl(signingKey, namespace, bundle, now + BUNDLE_URL_TTL_SECONDS),
  };
};

const noCredentials = (): Promise<never> =>
  Promise.reject(new Error("Keel's runners hold no credentials"));

const provider = (signingKey: string): SourceControlProvider => ({
  // Every KeelVerify payload already carries `provider`, so the engine never asks for an event.
  receiveEvent: async () => null,
  getSourceCheckout: (source) => checkoutOf(source, signingKey, Math.floor(Date.now() / 1000)),
  // No tree blobs means no engine cache: Keel's dependencies are baked into the image.
  listTreeBlobs: async () => null,
  getStepCredentialEnv: noCredentials,
  getPushCredentials: noCredentials,
  createPullRequest: async () => ({ status: "skipped" }),
  startStepNotification: async () => null,
});

/**
 * KeelVerify's source-control adapter, returned by `getProvider()`: candidates
 * are hydrated from content-addressed bundles fetched from
 * `bundles.keel.internal`, which only KeelSandbox's outbound handler answers,
 * and only for a URL keel signed: a runner is handed one, for its own
 * candidate, and can make no other. No git remote, no token and no public URL
 * ever reach a runner (spike S15, ADR 0007). Asked for a credential, it
 * refuses.
 */
export const keelBundleSource: SourceControlAdapter = {
  id: KEEL_BUNDLE_PROVIDER,
  repository: {},
  create: (env) => provider(Schema.decodeUnknownSync(SigningEnv)(env).BUNDLE_URL_SIGNING_KEY),
  accepts: (source) => source.provider === KEEL_BUNDLE_PROVIDER,
  assertSource: (source) => {
    if (source.provider !== KEEL_BUNDLE_PROVIDER)
      throw new Error(
        `KeelVerify runs only ${KEEL_BUNDLE_PROVIDER} sources, not ${source.provider}`,
      );
  },
};
