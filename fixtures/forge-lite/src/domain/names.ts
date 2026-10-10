/**
 * Validation for names that appear in URLs. Each check returns an error
 * message, or undefined when the value is acceptable.
 */

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPO_NAME = /^[a-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,49}$/;
const SHA = /^[0-9a-f]{40}$/;
const COLOR = /^[0-9a-f]{6}$/;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 350;
export const MAX_DISPLAY_NAME_LENGTH = 100;

export function checkUsername(value: string): string | undefined {
  if (USERNAME.test(value)) return undefined;
  return "username must be 1-39 characters of a-z, 0-9 and '-', and cannot start or end with '-'";
}

export function checkPassword(value: string): string | undefined {
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return undefined;
}

export function checkRepoName(value: string): string | undefined {
  if (!REPO_NAME.test(value) || value === "." || value === ".." || value.endsWith(".git")) {
    return "name must be 1-100 characters of a-z, 0-9, '.', '-' and '_', and cannot be '.', '..' or end in '.git'";
  }
  return undefined;
}

export function checkBranch(value: string): string | undefined {
  if (BRANCH.test(value) && !value.includes("..") && !value.endsWith(".lock")) return undefined;
  return "branch must be 1-100 characters of A-Z, a-z, 0-9, '.', '-' and '_', starting with a letter or digit";
}

export function checkLabel(value: string): string | undefined {
  if (LABEL.test(value)) return undefined;
  return "label must be 1-50 characters of a-z, 0-9 and '-', starting with a letter or digit";
}

export function checkSha(value: string): string | undefined {
  if (SHA.test(value)) return undefined;
  return "sha must be 40 lowercase hexadecimal characters";
}

export function checkColor(value: string): string | undefined {
  if (COLOR.test(value)) return undefined;
  return "color must be 6 lowercase hexadecimal characters, without '#'";
}
