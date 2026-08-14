#!/usr/bin/env bash
# Shared single-flight guard for SideStage production mutations.
#
# Source this file, call sidestage_acquire_release_lock immediately before the
# first production mutation, and install sidestage_release_release_lock as an
# EXIT trap. deploy.sh and rollback.sh intentionally use the same host-global
# lock path so two fleet terminals cannot race schema/build/up/record steps.

SIDESTAGE_DEPLOY_LOCK_FD=""

sidestage_acquire_release_lock() {
  # deploy.sh's health-failure path calls rollback.sh while it still owns the
  # lock. Only that parent-controlled call may inherit the critical section.
  if [[ "${SIDESTAGE_DEPLOY_LOCK_HELD:-0}" == "1" ]]; then
    return 0
  fi

  if ! command -v flock >/dev/null 2>&1; then
    echo "ERROR: flock is required to serialize SideStage deploy and rollback operations." >&2
    return 70
  fi

  local lock_file="${SIDESTAGE_DEPLOY_LOCK_FILE:-/tmp/sidestage-production-release.lock}"
  exec {SIDESTAGE_DEPLOY_LOCK_FD}>"$lock_file"
  if ! flock -n "$SIDESTAGE_DEPLOY_LOCK_FD"; then
    echo "ERROR: another SideStage deploy or rollback is already running." >&2
    echo "       Wait for that operation's terminal health/SHA verdict; do not overlap it." >&2
    exec {SIDESTAGE_DEPLOY_LOCK_FD}>&-
    SIDESTAGE_DEPLOY_LOCK_FD=""
    return 75
  fi
}

sidestage_release_release_lock() {
  if [[ -n "${SIDESTAGE_DEPLOY_LOCK_FD:-}" ]]; then
    flock -u "$SIDESTAGE_DEPLOY_LOCK_FD" 2>/dev/null || true
    exec {SIDESTAGE_DEPLOY_LOCK_FD}>&-
    SIDESTAGE_DEPLOY_LOCK_FD=""
  fi
}
