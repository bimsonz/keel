/**
 * The signing every URL Keel hands a box shares. A signed URL carries, in its
 * query, when it stops being good and an Ed25519 signature over a text that
 * names whose object it opens, which object, and that expiry:
 * `?exp=<unix seconds>&sig=<base64url>`. Each family of URL says what its text
 * is (`bundle.ts`, `deps.ts`), and no family's text is another's, so a
 * signature made for one opens nothing of the other.
 */

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A key as Terraform gives it: PEM, or the bare base64 of its DER. */
const derOf = (key: string): Uint8Array<ArrayBuffer> =>
  fromBase64(key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));

/**
 * `url` with its expiry and Keel's signature over `text` as its query. Only
 * keel holds the signing key (PKCS#8), so only keel makes a URL a host answers.
 */
export const signedUrl = async (
  signingKey: string,
  url: string,
  expires: number,
  text: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    derOf(signingKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", key, text);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${url}?exp=${expires}&sig=${sig}`;
};

/**
 * Whether a URL's query carries an expiry not yet past at `now` (unix
 * seconds) and Keel's signature over the text `textAt` gives for that expiry.
 * No signature, one past its `exp`, or one made over any other text is
 * refused alike. It needs only the public key (SPKI), which signs nothing.
 */
export const urlSigned = async (
  publicKey: string,
  query: URLSearchParams,
  now: number,
  textAt: (expires: number) => Uint8Array<ArrayBuffer>,
): Promise<boolean> => {
  const [exp, sig] = [query.get("exp"), query.get("sig")];
  if (exp === null || !/^[0-9]{1,12}$/.test(exp)) return false;
  if (sig === null || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  const expires = Number(exp);
  if (expires < now) return false;
  const key = await crypto.subtle.importKey("spki", derOf(publicKey), { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64(sig.replace(/-/g, "+").replace(/_/g, "/")),
    textAt(expires),
  );
};
