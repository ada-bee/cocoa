#!/bin/sh
set -eu

data_dir=${T3CODE_HOME:-/data}
settings_file=${data_dir}/userdata/settings.json

umask 027
mkdir -p \
  "${data_dir}/caches" \
  "${data_dir}/userdata/logs" \
  "${data_dir}/worktrees"

if [ ! -e "${settings_file}" ]; then
  cp /opt/cocoa/defaults/settings.json "${settings_file}"
  chmod 0640 "${settings_file}"
fi

exec bun /opt/cocoa/dist/cocoa-bin.mjs "$@"
