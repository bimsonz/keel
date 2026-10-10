#!/usr/bin/env bash
# Filters stdin for the public repo: account id, workers.dev subdomain, emails,
# home paths and the scratch path. Needs CLOUDFLARE_ACCOUNT_ID and SUBDOMAIN.
set -u
sed -E \
  -e "s/${CLOUDFLARE_ACCOUNT_ID:-__none__}/<account-id>/g" \
  -e "s/\.${SUBDOMAIN:-__none__}\.workers\.dev/.<subdomain>.workers.dev/g" \
  -e "s/${SUBDOMAIN:-__none__}/<subdomain>/g" \
  -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/<email>/g' \
  -e 's#/[U]sers/[^ "]*#<home-path>#g' \
  -e 's#/private/tmp/[^ "]*#<scratch>#g' \
  -e 's/\x1b\[[0-9;]*m//g'
