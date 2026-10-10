import { constantTimeEqual, sha256Hex } from "../crypto.ts";

/**
 * Salted SHA-256. This keeps a fixture with hundreds of sign-ups fast; a
 * production forge would use a deliberately slow function such as PBKDF2.
 */
export function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${password}`);
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  return constantTimeEqual(await hashPassword(password, salt), expectedHash);
}
