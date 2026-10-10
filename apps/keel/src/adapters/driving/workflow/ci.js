// The typed boundary around @cloudflare/ci, which ships unbuilt TypeScript that
// does not compile under this repo's compiler flags. The bundler reads this file;
// the type checker reads ci.d.ts.
export { CIWorkflow } from "@cloudflare/ci";
