#!/usr/bin/env bash
#
# Runs the built image the way compose runs it and checks that the hardening is real.
#
# #39 asks for "non-root, read-only rootfs, dropped capabilities, verified at runtime".
# Everything before this script was configuration: `USER node` in the Dockerfile and
# four security keys in compose.yaml, both of which are claims. A claim about a
# container is worth what a test of it is worth — `read_only: true` protects nothing if
# the app turns out to need a writable path outside /data, and the way that gets
# discovered should not be a deployment.
#
# So the image is started with exactly the flags compose uses, and then asked:
#
#   - is the process non-root, and is it the uid the image declares?
#   - is /app actually unwritable, and /data actually writable?
#   - are all capabilities really gone, and is setuid escalation blocked?
#   - does the HEALTHCHECK command work at all — because a broken one makes Docker
#     restart a perfectly healthy container every interval, forever?
#   - was the egress allowlist installed in a real container, not just in a unit test?
#
# It also records image size and time to first response. Those two are not pass/fail
# judgements about the design, they are tripwires: the ceilings are set a little above
# where the numbers sit today, so a change that doubles either one has to be a
# deliberate edit to this file rather than something nobody noticed.
#
# Usable by hand, which is the point of it being a script rather than workflow YAML:
#
#   docker build -t balancr:test . && scripts/verify-image.sh balancr:test
set -euo pipefail

IMAGE=${1:?usage: verify-image.sh <image>}
PORT=${PORT:-3999}
IMAGE_MAX_MB=${IMAGE_MAX_MB:-750}
STARTUP_MAX_S=${STARTUP_MAX_S:-20}

NAME="balancr-verify-$$"
VOLUME="balancr-verify-$$"
failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

check() {
  # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    pass "$1 ($3)"
  else
    fail "$1: expected $2, got $3"
  fi
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] || [ "$failures" -ne 0 ]; then
    printf '\n--- container logs ---\n'
    docker logs "$NAME" 2>&1 | tail -40 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf 'verifying %s\n\n' "$IMAGE"

# --- size ---------------------------------------------------------------------
#
# Whatever the daemon's image store reports: uncompressed layers with the classic
# graph driver, compressed content with the containerd one. So this number is
# comparable between runs of the same environment — which is all a tripwire needs —
# and not comparable to what `docker images` prints on a laptop. Do not go chasing
# the difference; the CI value is the one the ceiling below is set against.
bytes=$(docker image inspect -f '{{.Size}}' "$IMAGE")
size_mb=$((bytes / 1000000))

# --- run it the way compose does ----------------------------------------------
#
# The health intervals are overridden, and only the intervals: the image declares a
# 30s start period because a real deployment should not be declared unhealthy while
# SQLite is opening, and waiting that out here would add half a minute to every build
# to learn nothing. The command being tested is the image's own.
docker volume create "$VOLUME" >/dev/null
started=$(date +%s)
docker run -d --name "$NAME" \
  --init \
  --read-only \
  --tmpfs /tmp:size=64m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -v "$VOLUME:/data" \
  -p "127.0.0.1:$PORT:3000" \
  --health-interval=2s --health-start-period=1s --health-retries=10 \
  -e NODE_ENV=production \
  -e PUBLIC_BASE_URL=https://balancr.invalid \
  -e TRUSTED_PROXY_CIDRS=172.16.0.0/12 \
  -e ACTUAL_SERVER_URL=http://actual.invalid:5006 \
  -e ACTUAL_PASSWORD=verify \
  -e ACTUAL_SYNC_ID=00000000-0000-0000-0000-000000000000 \
  -e GHOSTFOLIO_URL=http://ghostfolio.invalid:3333 \
  -e GHOSTFOLIO_SECURITY_TOKEN=verify \
  -e SESSION_SECRET=verification-session-secret-of-sufficient-length \
  -e AUTH_LOCAL_ENABLED=true \
  -e JOBS_ENABLED=false \
  "$IMAGE" >/dev/null

# --- time to first response ---------------------------------------------------
#
# Wall clock from `docker run` to a 200, which is the number an operator experiences.
# Nothing in startup touches the network — jobs are off — so a regression here means
# something was added to the boot path, which is exactly what this should catch.
ready=""
for _ in $(seq 1 "$((STARTUP_MAX_S * 5))"); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    ready=$(date +%s)
    break
  fi
  if [ -z "$(docker ps -q -f "name=$NAME")" ]; then
    fail 'the container exited before it answered'
    exit 1
  fi
  sleep 0.2
done
if [ -z "$ready" ]; then
  fail "no response on /healthz within ${STARTUP_MAX_S}s"
  exit 1
fi
startup_s=$((ready - started))
pass "answered /healthz in ${startup_s}s"

# --- the posture --------------------------------------------------------------
uid=$(docker exec "$NAME" id -u)
if [ "$uid" = "0" ]; then
  fail 'running as root'
else
  pass "running as uid $uid"
fi

# `USER node` is the declaration; this is the observation. They can disagree — an
# entrypoint that switches user, or a base image that renumbers node — and the whole
# point of a runtime check is to not take the Dockerfile's word for it.
check 'the user is node' 'node' "$(docker exec "$NAME" id -un)"

if docker exec "$NAME" sh -c 'echo x > /app/probe' 2>/dev/null; then
  fail '/app is writable — the root filesystem is not read-only'
else
  pass '/app is not writable'
fi

if docker exec "$NAME" sh -c 'echo x > /data/probe && rm /data/probe' 2>/dev/null; then
  pass '/data is writable'
else
  fail '/data is not writable — the volume is unusable'
fi

# /tmp is the one exception compose grants, and something has to want it: Node writes
# there for diagnostics and better-sqlite3 for temp stores under memory pressure.
if docker exec "$NAME" sh -c 'echo x > /tmp/probe && rm /tmp/probe' 2>/dev/null; then
  pass '/tmp is writable (tmpfs)'
else
  fail '/tmp is not writable — a read-only rootfs needs it'
fi

# All zeroes. Printed as the kernel prints it, because a partial drop is the
# interesting failure and "some capabilities" is not a useful thing to report.
caps=$(docker exec "$NAME" sh -c "grep '^CapEff' /proc/self/status | awk '{print \$2}'")
check 'effective capabilities are empty' '0000000000000000' "$caps"

nnp=$(docker exec "$NAME" sh -c "grep '^NoNewPrivs' /proc/self/status | awk '{print \$2}'")
check 'no-new-privileges is set' '1' "$nnp"

# --- the native modules, all of them ------------------------------------------
#
# Answering /healthz already proves better-sqlite3 loaded, because migrations run
# before the port opens. This asks both native modules directly, which is the check
# that keeps `scripts/prune-runtime-deps.mjs` honest: it deletes platform binaries,
# and a wrong deletion in a module that only loads on the login path would otherwise
# be found by whoever tried to log in.
if docker exec "$NAME" node -e \
  "Promise.all([import('better-sqlite3'), import('argon2')]).then(() => {}, (e) => { console.error(e.message); process.exit(1) })"; then
  pass 'better-sqlite3 and argon2 both load'
else
  fail 'a native module does not load — check the runtime prune'
fi

# --- the healthcheck the image declares ---------------------------------------
health=""
for _ in $(seq 1 30); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$health" = starting ] || break
  sleep 1
done
check 'docker reports the container healthy' 'healthy' "$health"

# --- wiring that only a real container shows -----------------------------------
if docker logs "$NAME" 2>&1 | grep -q 'egress allowlist installed'; then
  pass 'the egress allowlist was installed at startup'
else
  fail 'no egress allowlist in the startup logs'
fi

# --- budgets ------------------------------------------------------------------
if [ "$size_mb" -gt "$IMAGE_MAX_MB" ]; then
  fail "image is ${size_mb} MB, over the ${IMAGE_MAX_MB} MB tripwire"
else
  pass "image is ${size_mb} MB (tripwire ${IMAGE_MAX_MB} MB)"
fi

if [ "$startup_s" -gt "$STARTUP_MAX_S" ]; then
  fail "startup took ${startup_s}s, over the ${STARTUP_MAX_S}s tripwire"
else
  pass "startup ${startup_s}s (tripwire ${STARTUP_MAX_S}s)"
fi

# --- the record ---------------------------------------------------------------
#
# Written where a reviewer sees it without opening a log: the numbers only work as a
# tripwire if somebody reads them on the way past.
summary=$(
  cat <<EOF
### Image

| | |
|---|---|
| Size | ${size_mb} MB as the daemon reports it (tripwire ${IMAGE_MAX_MB} MB) |
| Time to first \`/healthz\` | ${startup_s}s (tripwire ${STARTUP_MAX_S}s) |
| User | ${uid} \`node\`, non-root |
| Root filesystem | read-only, \`/data\` and \`/tmp\` writable |
| Capabilities | \`CapEff=${caps}\`, \`NoNewPrivs=${nnp}\` |
| Health | ${health} |
EOF
)
printf '\n%s\n' "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall checks passed\n'
