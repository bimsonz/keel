/** One half of a key pair, exported in `format` and wrapped as the PEM Terraform's `tls_private_key` outputs. */
const pem = async (label: string, format: "pkcs8" | "spki", key: CryptoKey): Promise<string> => {
  const der = await crypto.subtle.exportKey(format, key);
  if (!(der instanceof ArrayBuffer)) throw new Error(`${format} did not export as bytes`);
  return `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END ${label}-----\n`;
};

/**
 * A fresh Ed25519 pair for signing bundle URLs, each half as Terraform
 * outputs it: the signing key keel holds as a secret (PKCS#8), and the
 * public key keel-verify's bundle host checks against (SPKI).
 */
export async function makeBundleUrlKeys(): Promise<{
  readonly signingKey: string;
  readonly publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
  return {
    signingKey: await pem("PRIVATE KEY", "pkcs8", pair.privateKey),
    publicKey: await pem("PUBLIC KEY", "spki", pair.publicKey),
  };
}
