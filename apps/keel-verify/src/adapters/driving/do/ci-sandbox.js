// The typed boundary around @cloudflare/ci's worker entry, which ships unbuilt
// TypeScript that does not compile under this repo's flags. The bundler reads
// this file; the type checker reads ci-sandbox.d.ts.
export { CiSandbox } from "@cloudflare/ci/worker";
