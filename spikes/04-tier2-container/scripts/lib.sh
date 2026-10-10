#!/usr/bin/env bash
# Shared helpers. Source it. REMOTE and TOKEN come from the environment
# (`wrangler artifacts repos create --json` / `issue-token`).
#
# The token travels only in an `Authorization: Bearer` header set through
# GIT_CONFIG_* env vars, so it is never in argv, a remote URL or .git/config.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=keel-spike GIT_AUTHOR_EMAIL=spike@keel.invalid
export GIT_COMMITTER_NAME=keel-spike GIT_COMMITTER_EMAIL=spike@keel.invalid
export GIT_AUTHOR_DATE='2026-10-10T00:00:00Z' GIT_COMMITTER_DATE='2026-10-10T00:00:00Z'

# Redact tokens first (art_v1_/art_v2_ forms, with or without ?expires=), then
# the account id wherever it appears.
redact() {
  perl -pe 's#art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?#<token>#g; s#\b[0-9a-f]{32}\b#<acct>#g'
}

agit() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
    GIT_CONFIG_VALUE_0="Authorization: Bearer ${TOKEN:?TOKEN unset}" git "$@"
}
