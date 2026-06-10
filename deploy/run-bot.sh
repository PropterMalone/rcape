#!/usr/bin/env bash
# pattern: Imperative Shell
# systemd ExecStart wrapper. The bot needs PDS_ADMIN_PASSWORD to mint case
# accounts when provisioning a docket, but that secret is deliberately kept out
# of .env (it's the PDS super-admin credential). Inject only that one var from
# pds/pds.env, then run the bot — everything else still comes from .env via the
# `bot` npm script's `node --env-file`. We export only the admin password (not
# `source pds/pds.env`) so the PDS container's own PDS_HOSTNAME/JWT secret/etc.
# don't leak into the bot's environment or override .env (env beats --env-file).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PDS_ADMIN_PASSWORD="$(grep '^PDS_ADMIN_PASSWORD=' pds/pds.env | cut -d= -f2-)"
exec /usr/bin/npm run bot
