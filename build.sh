#!/bin/bash
# Builds the fpk against the latest upstream @deepseek-ai/dsh release and
# places it in dist/. Optionally builds a specific version: ./build.sh 0.1.0-rc.6
#
# Pipeline: resolve version -> pin it in package.json -> remote Linux install
# (nas31; skipped when the requested runtime is already staged) -> dist
# rewrite (idempotent) -> fnpack build -> dist/dsh_<app>_dsh<dsh>.fpk
#
# Prereqs: node + npm + fnpack locally, SSH access to the build NAS
# (DSH_BUILD_HOST, default nas31) with the nodejs_v24 runtime and g++/make.
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

if [ $# -gt 1 ]; then
  echo "usage: ./build.sh [dsh-version]   (default: latest from npm)" >&2
  exit 1
fi

if [ $# -eq 1 ]; then
  version=$1
else
  echo "Resolving latest @deepseek-ai/dsh from npm ..."
  version=$(npm view @deepseek-ai/dsh version) || {
    echo "npm view failed (offline?); pass an explicit version: ./build.sh 0.1.0-rc.6" >&2
    exit 1
  }
fi

pinned=$(node -p "require('./package.json').dshVersion")
if [ "$version" != "$pinned" ]; then
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dshVersion='${version}';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
  echo "Pinned dshVersion: ${pinned} -> ${version}"
else
  echo "dshVersion stays at ${version}"
fi

# The fpk version mirrors the upstream dsh version so the installed app
# version says which upstream it carries. Wrapper-only re-releases against
# the same upstream bump the suffix: DSH_WRAPPER_BUILD=1 ./build.sh -> 0.1.0-rc.6.1
appver="${version}${DSH_WRAPPER_BUILD:+.${DSH_WRAPPER_BUILD}}"
sed -i "s/^version=.*/version=${appver}/" src/manifest
echo "manifest version -> $(sed -n 's/^version=//p' src/manifest)"

# Same-version rebuilds skip the ~10min remote install when the runtime tree
# for that version is already staged in cache/.
staged=$(node -p "try{require('./cache/dsh-runtime/package.json').dependencies['@deepseek-ai/dsh']}catch{''}" 2>/dev/null || true)
if [ "$staged" = "$version" ] && [ -f "cache/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "Runtime for ${version} already staged; skipping remote install."
else
  node scripts/fetch-dsh.mjs
fi

node scripts/rewrite-dist.mjs
node scripts/pack-runtime.mjs

(cd src && fnpack build)

appver=$(sed -n 's/^version=//p' src/manifest | head -1 | tr -d '[:space:]')
mkdir -p dist
out="dist/dsh_${appver}.fpk"
# Move (not copy) so src/ holds no fpk after the build.
mv src/dsh.fpk "$out"
printf 'app: %s\ndsh: %s\nbuilt: %s\n' "$appver" "$version" "$(date '+%Y-%m-%d %H:%M:%S')" > "${out}.info.txt"
echo "Built ${out}"
