import { ContentHash } from "@keeltown/core/kernel";
import { bundleUrl } from "@keeltown/runner-protocol";
import { Schema } from "effect";
import { KEEL_BUNDLE_PROVIDER } from "../../../rpc/index.ts";
import type {
  SourceControlAdapter,
  SourceControlCheckout,
  SourceControlProvider,
  SourceControlSource,
} from "./ci.js";

const ProviderData = Schema.Struct({ bundle: ContentHash });

/** Every checkout Keel hands a runner: the candidate's bundle on the virtual bundle host. */
export const checkoutOf = (source: SourceControlSource): SourceControlCheckout => ({
  kind: "archive",
  url: bundleUrl(Schema.decodeUnknownSync(ProviderData)(source.providerData).bundle),
});

const noCredentials = (): Promise<never> =>
  Promise.reject(new Error("Keel's runners hold no credentials"));

const provider: SourceControlProvider = {
  // Every KeelVerify payload already carries `provider`, so the engine never asks for an event.
  receiveEvent: async () => null,
  getSourceCheckout: async (source) => checkoutOf(source),
  // No tree blobs means no engine cache: Keel's dependencies are baked into the image.
  listTreeBlobs: async () => null,
  getStepCredentialEnv: noCredentials,
  getPushCredentials: noCredentials,
  createPullRequest: async () => ({ status: "skipped" }),
  startStepNotification: async () => null,
};

/**
 * KeelVerify's source-control adapter, returned by `getProvider()`: candidates
 * are hydrated from content-addressed bundles fetched from
 * `bundles.keel.internal`, which only KeelSandbox's outbound handler answers.
 * No git remote, no token and no public URL ever reach a runner (spike S15,
 * ADR 0007). Asked for a credential, it refuses.
 */
export const keelBundleSource: SourceControlAdapter = {
  id: KEEL_BUNDLE_PROVIDER,
  repository: {},
  create: () => provider,
  accepts: (source) => source.provider === KEEL_BUNDLE_PROVIDER,
  assertSource: (source) => {
    if (source.provider !== KEEL_BUNDLE_PROVIDER)
      throw new Error(
        `KeelVerify runs only ${KEEL_BUNDLE_PROVIDER} sources, not ${source.provider}`,
      );
  },
};
