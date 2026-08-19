#!/bin/bash
# Between-starts supervision for dsh web and the gateway relay.
#
# fnOS appcenter has no supervisor of its own: once cmd/main start returns,
# nothing watches the processes. That was fine until dshmarket grew a
# self-restart button whose detached replacement process no pid file tracked
# (the app showed "stopped" forever while actually serving), and until real
# crashes left the app down until someone clicked start. cmd/main therefore
# spawns this loop in its own session on every successful start:
#
#   - restart requests: the relay intercepts the market's POST
#     /dsh-market/restart (upstream's own restart spawns an untracked,
#     wrong-cwd replacement) and drops $TRIM_PKGVAR/restart-web; the restart
#     itself runs inside cmd/main supervised-restart so the full launch
#     environment, boot watchdog and lastgood snapshot all apply.
#   - crash healing: dsh web's pid gone (or the process alive but not
#     serving beyond the boot patience — the silent-hang failure mode) →
#     same supervised restart.
#   - relay healing: the relay pid gone → cmd/main relaunch-relay (without
#     it the app answers "stopped" in appcenter while web lives).
#
# Failure backoff: a restart that still ends without dsh web serving (reseed
# failed too) is retried with growing delay, capped at 5 minutes.
#
# Environment (exported by start_supervisor in cmd/main): TRIM_PKGVAR,
# TRIM_APPDEST, DSH_PORT, LOG_FILE, DSH_SUPERVISE_POLL, DSH_BOOT_TIMEOUT.

set -u

POLL="${DSH_SUPERVISE_POLL:-5}"
HUNG_THRESHOLD="${DSH_BOOT_TIMEOUT:-180}"
# cmd/main hands its own resolved path down as MAIN_BIN (lifecycle scripts
# live under /var/apps/<appname>/cmd/, not TRIM_APPDEST — a hardcoded guess
# here broke every supervised restart in rc.7.14).
MAIN_BIN="${MAIN_BIN:-/var/apps/${TRIM_APPNAME:-dsh}/cmd/main}"
LOG_FILE="${TRIM_PKGVAR}/app.log"
RESTART_FLAG="${TRIM_PKGVAR}/restart-web"
BACKOFF=0
hung_secs=0

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - supervisor: $1" >> "$LOG_FILE"
}

pid_up() {
  local pid
  pid="$(head -n 1 "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_serving() {
  curl -s --max-time 3 -o /dev/null "http://127.0.0.1:${DSH_PORT:-3080}/"
}

# One restart attempt through cmd/main (single source of the launch
# environment). $$ is passed so an app-center stop that kills this supervisor
# also aborts the restart instead of respawning web afterwards.
supervised_restart() {
  if "$MAIN_BIN" supervised-restart "$$"; then
    BACKOFF=0
    return 0
  fi
  BACKOFF=$((BACKOFF + 1))
  local delay=$((30 * BACKOFF))
  [ "$delay" -gt 300 ] && delay=300
  log "restart attempt failed; backing off ${delay}s (attempt $BACKOFF)"
  sleep "$delay"
  return 1
}

log "supervising dsh web (poll ${POLL}s, hung threshold ${HUNG_THRESHOLD}s)"

while :; do
  if [ -e "$RESTART_FLAG" ]; then
    log "restart requested (relay flag)"
    supervised_restart
    hung_secs=0
    continue
  fi

  if ! pid_up "${TRIM_PKGVAR}/relay.pid"; then
    log "relay is down; relaunching"
    "$MAIN_BIN" relaunch-relay || log "relay relaunch failed"
  fi

  if ! pid_up "${TRIM_PKGVAR}/dsh.pid"; then
    log "dsh web process is gone; restarting under supervision"
    supervised_restart
    hung_secs=0
    continue
  fi

  if port_serving; then
    hung_secs=0
  else
    hung_secs=$((hung_secs + POLL))
    if [ "$hung_secs" -ge "$HUNG_THRESHOLD" ]; then
      log "dsh web alive but not serving for ${hung_secs}s; restarting under supervision"
      supervised_restart
      hung_secs=0
      continue
    fi
  fi

  sleep "$POLL"
done
