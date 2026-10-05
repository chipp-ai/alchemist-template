#!/usr/bin/env bash
# One Deno version per project, and the same one as the Chipp platform.
#
# `.dvmrc` holds this project's Deno version. CI's setup-deno reads it
# (`deno-version-file: .dvmrc`); this script fails when the Dockerfile or a
# workflow pins anything else.
#
# With --platform it also compares `.dvmrc` to the platform's one version,
# served at $PLATFORM_DENO_VERSION_URL. Only the alchemist-template repos run
# that step (see ci.yml): a project made from the template must not go red
# just because the platform moved on.
set -euo pipefail
cd "$(dirname "$0")/.."

want="$(tr -d '[:space:]' < .dvmrc)"
if ! echo "$want" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "::error::.dvmrc must hold one exact version, got '$want'"; exit 1
fi
bad=0
while IFS= read -r line; do
  tag="${line##*denoland/deno:}"; tag="${tag%% *}"
  if [ "$tag" != "$want" ]; then
    echo "::error file=Dockerfile::FROM denoland/deno:$tag, .dvmrc says $want"; bad=1
  fi
done < <(grep -E '^FROM[[:space:]]+denoland/deno:' Dockerfile || true)
if grep -REn '^[[:space:]]*deno-version:[[:space:]]*[^[:space:]]' .github/workflows/ ; then
  echo "::error::a workflow pins deno-version literally; use deno-version-file: .dvmrc"; bad=1
fi

if [ "${1:-}" = "--platform" ]; then
  url="${PLATFORM_DENO_VERSION_URL:-https://build.chipp.ai/alchemist-api/v1/platform/deno-version}"
  body="$(curl -fsS --retry 3 --retry-delay 5 --max-time 20 "$url" || true)"
  platform="$(printf '%s' "$body" | sed -n 's/.*"denoVersion":"\([0-9.]*\)".*/\1/p')"
  if [ -z "$platform" ]; then
    echo "::error::could not read the platform Deno version from $url"; exit 1
  fi
  if [ "$platform" != "$want" ]; then
    echo "::error::.dvmrc says $want but the platform runs Deno $platform. Move this template to $platform."; bad=1
  fi
  echo "platform Deno: $platform"
fi

[ "$bad" = 0 ] && echo "Deno version OK: $want"
exit "$bad"
