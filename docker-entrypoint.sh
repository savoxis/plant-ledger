#!/bin/sh
set -e
# /data is a host bind mount -- its on-disk ownership is whatever the
# host has, not whatever the image's build-time chown set. Fix it here,
# every boot, before dropping to the unprivileged user, so this never
# depends on the host directory having been created just right.
chown -R app:app /data
exec su-exec app "$@"
