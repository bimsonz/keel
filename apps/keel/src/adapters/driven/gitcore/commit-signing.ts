import {
  allowedSigners,
  importSshSigningKey,
  type Signature,
  type SignerKey,
  signsAt,
  type SshSigningKey,
  sshPublicKey,
  sshSignature,
} from "@keeltown/gitcore";
import { Schema } from "effect";

/** What a deployment says of the commits Keel composes: its own settings, as its Worker holds them. */
export interface CommitSigningConfig {
  /** `KEEL_HOST`. Keel commits as `Keel <keel@<host>>`, the principal its signers file names. */
  readonly host: string;
  /** `KEEL_COMMIT_SIGNING_KEY`: an Ed25519 private key as PKCS#8 PEM, apart from every other key Keel holds. */
  readonly signingKey: string | undefined;
  /** `KEEL_COMMIT_SIGNERS`: every key Keel signs or has signed commits with, each with its window, as JSON. */
  readonly signers: string;
}

/**
 * A stock verifier on daylight time reads a commit an hour late (git hands
 * ssh-keygen the committer's time in local digits, and ssh-keygen reads them
 * as standard time). So Keel signs only where its key's window also holds the
 * hour after the commit, and such a commit verifies wherever it is checked.
 */
export const VERIFIER_SKEW_SECONDS = 3600;

const Signers = Schema.Array(
  Schema.Struct({
    /** `ssh-ed25519 <base64>`. */
    publicKey: Schema.String,
    /** ISO 8601, to the second. */
    validAfter: Schema.optional(Schema.String),
    validBefore: Schema.optional(Schema.String),
  }),
);

/** Who signs Keel's commits, as a commit's committer line and the signers file both name it. */
export const keelPrincipal = (host: string) => `keel@${host}`;

/**
 * An agent as the author of what it landed: its given handle (its id while it
 * has none), at an address under Keel's own `agents.` domain, which no person
 * can hold and no submitted commit can claim.
 */
export const agentAuthor = (
  agent: { readonly id: string; readonly handle?: string | undefined },
  host: string,
): { readonly name: string; readonly email: string } => ({
  name: agent.handle ?? agent.id,
  email: `${agent.id}@agents.${host}`,
});

/** Keel as the committer of what it composes at `at` (milliseconds). */
export const keelCommitter = (host: string, at: number): Signature => ({
  name: "Keel",
  email: keelPrincipal(host),
  time: Math.floor(at / 1000),
});

function seconds(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const at = Date.parse(iso) / 1000;
  if (!Number.isInteger(at))
    throw new Error("KEEL_COMMIT_SIGNERS holds a time that is not ISO 8601 to the second");
  return at;
}

/** The keys `KEEL_COMMIT_SIGNERS` holds. Anything else in the setting is a defect that names it. */
export function decodeSigners(json: string): readonly SignerKey[] {
  let listed: typeof Signers.Type;
  try {
    listed = Schema.decodeUnknownSync(Signers)(JSON.parse(json));
  } catch {
    throw new Error("KEEL_COMMIT_SIGNERS is not a JSON list of keys");
  }
  return listed.map((signer) => ({
    publicKey: signer.publicKey,
    validAfter: seconds(signer.validAfter),
    validBefore: seconds(signer.validBefore),
  }));
}

/** The allowed-signers file Keel publishes: its principal, with every key it signs or has signed with. */
export function signersFile(config: Pick<CommitSigningConfig, "host" | "signers">): string {
  return allowedSigners(keelPrincipal(config.host), decodeSigners(config.signers));
}

/** Signs one commit: handed it unsigned, answers the armored signature for its `gpgsig` header. */
export type CommitSigner = (unsigned: Uint8Array) => Promise<string>;

/**
 * The signer for commits committed at `time` (Unix seconds), by the
 * deployment's key. It rejects, and the compose that asked dies, when the
 * deployment holds no key, or when the published signers file would not vouch
 * for a commit this key signed at that time: Keel composes no commit it
 * cannot sign, and none a reader could not verify.
 */
export function commitSigner(config: CommitSigningConfig): (time: number) => Promise<CommitSigner> {
  let imported: Promise<SshSigningKey> | undefined;
  return async (time) => {
    if (config.signingKey === undefined || config.signingKey === "")
      throw new Error("KEEL_COMMIT_SIGNING_KEY is not set: Keel composes no commit it cannot sign");
    imported ??= importSshSigningKey(config.signingKey);
    const key = await imported;
    const publicKey = sshPublicKey(key.publicKey);
    const vouched = decodeSigners(config.signers).some(
      (signer) =>
        signer.publicKey === publicKey &&
        signsAt(signer, time) &&
        signsAt(signer, time + VERIFIER_SKEW_SECONDS),
    );
    if (!vouched)
      throw new Error(
        `KEEL_COMMIT_SIGNERS does not hold the signing key for ${new Date(time * 1000).toISOString()}: a commit signed now would not verify against Keel's signers file`,
      );
    return (unsigned) => sshSignature(key, unsigned);
  };
}
