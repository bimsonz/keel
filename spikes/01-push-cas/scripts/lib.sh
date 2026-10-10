#!/usr/bin/env bash
# Shared helpers for spikes 01 and 03. Source it; it expects REMOTE and TOKEN in
# the environment (from `wrangler artifacts repos get` / `issue-token`).
#
# The token travels only in an `Authorization: Bearer` header set through
# GIT_CONFIG_* env vars, so it is never in argv, a remote URL or .git/config.

# Hermetic git: no system or global config, no prompts, fixed identity.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=keel-spike GIT_AUTHOR_EMAIL=spike@keel.invalid
export GIT_COMMITTER_NAME=keel-spike GIT_COMMITTER_EMAIL=spike@keel.invalid

# Redact tokens (art_v1_/art_v2_ forms, with or without ?expires=) and the
# account id in remote hosts from anything captured.
redact() {
  sed -E 's#art_v[0-9]+_[A-Za-z0-9_]+(\?expires=[0-9]+)?#<token>#g; s#[0-9a-f]{32}\.artifacts#<acct>.artifacts#g'
}

# git with the bearer header for $TOKEN.
agit() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
    GIT_CONFIG_VALUE_0="Authorization: Bearer ${TOKEN:?TOKEN unset}" git "$@"
}

# Current value of a remote ref (empty if absent), read straight from the server.
remote_ref() { agit ls-remote "${REMOTE:?}" "$1" | awk '{print $1}'; }

now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
