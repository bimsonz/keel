declare namespace Cloudflare {
  interface Env {
    /** Test-only: the private half of the pool's bundle URL key pair, so a case can sign a URL as keel does. */
    TEST_BUNDLE_URL_SIGNING_KEY: string;
  }
}
