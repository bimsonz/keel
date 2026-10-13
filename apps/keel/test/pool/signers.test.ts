// Keel's published signers file, through the Worker's own fetch handler: it
// holds the public half of the key this deployment signs commits with, under
// the principal its commits name as committer.
import { env, exports } from "cloudflare:workers";
import { allowedSigners, importSshSigningKey, sshPublicKey } from "@keeltown/gitcore";
import { expect, it } from "vitest";

const SIGNERS = "https://keel.localhost/.well-known/keel/allowed-signers";

it("[signers.route] serves the allowed-signers file: the deployment's own signing key under keel@<host>, open to anyone", async () => {
  const response = await exports.default.fetch(SIGNERS);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  // The public half is derived here, in workerd, from the secret the composer signs with.
  const key = await importSshSigningKey(env.KEEL_COMMIT_SIGNING_KEY);
  const file = await response.text();
  expect(file).toBe(
    allowedSigners(`keel@${env.KEEL_HOST}`, [{ publicKey: sshPublicKey(key.publicKey) }]),
  );
  expect(file).toMatch(/^keel@keel\.localhost namespaces="git" ssh-ed25519 [A-Za-z0-9+/=]+\n$/);
});

it("[signers.route-get-only] answers nothing but a GET, and no neighbouring path", async () => {
  expect((await exports.default.fetch(SIGNERS, { method: "POST" })).status).toBe(404);
  expect((await exports.default.fetch(`${SIGNERS}/x`)).status).toBe(404);
  expect((await exports.default.fetch(SIGNERS.replace("/keel/", "/"))).status).toBe(404);
});
