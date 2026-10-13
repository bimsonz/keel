// From sshsig alone: a vitest config loads this file with Node's type stripping, which gitcore's index does not survive.
import { importSshSigningKey, sshPublicKey } from "@keeltown/gitcore/sshsig";
import { makeBundleUrlKeys } from "./bundle-url-keys.ts";

/**
 * A fresh Ed25519 key for signing commits, as a deployment holds it: the
 * signing key Keel keeps as a secret (PKCS#8 PEM, as Terraform outputs it),
 * its public half as an allowed-signers line names it, and a
 * `KEEL_COMMIT_SIGNERS` setting that lists that key for all time.
 */
export async function makeCommitSigningKeys(): Promise<{
  readonly signingKey: string;
  readonly publicKey: string;
  readonly signers: string;
}> {
  const { signingKey } = await makeBundleUrlKeys();
  const publicKey = sshPublicKey((await importSshSigningKey(signingKey)).publicKey);
  return { signingKey, publicKey, signers: JSON.stringify([{ publicKey }]) };
}
