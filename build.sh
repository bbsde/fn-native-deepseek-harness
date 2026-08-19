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

# DSH_APPVER + DSH_UPSTREAM (both from the CI git tag) override the
# positional/DSH_WRAPPER_BUILD version logic: DSH_UPSTREAM is the upstream
# dsh version (e.g. 0.1.0-rc.6), DSH_APPVER the full fpk version
# (e.g. 0.1.0-rc.6.2). Tag = single version source, nothing to edit by hand.
if [ -n "${DSH_APPVER:-}" ]; then
  version="${DSH_UPSTREAM:?DSH_UPSTREAM is required when DSH_APPVER is set}"
  echo "DSH_APPVER=${DSH_APPVER} (upstream dshVersion=${version})"
elif [ $# -eq 1 ]; then
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
if [ -n "${DSH_APPVER:-}" ]; then
  appver="${DSH_APPVER}"
else
  appver="${version}${DSH_WRAPPER_BUILD:+.${DSH_WRAPPER_BUILD}}"
fi
sed -i "s/^version=.*/version=${appver}/" src/manifest
echo "manifest version -> $(sed -n 's/^version=//p' src/manifest)"

# Icons are exported @2x from the 600x600 master (assets/ICON.png) by
# make-icons.mjs; regenerate automatically when the master is newer than any
# export (or one is missing). Needs sharp from the staged runtime tree, so it
# runs after the fetch/staging block above. The icon exports are arch-agnostic,
# so this runs once before the per-arch loop.
icons_fresh=yes
for f in src/ICON.PNG src/ICON_256.PNG src/app/ui/images/icon_64.png src/app/ui/images/icon_256.png; do
  [ -f "$f" ] && [ ! assets/ICON.png -nt "$f" ] || icons_fresh=no
done
if [ "$icons_fresh" = yes ]; then
  echo "Icons up to date with assets/ICON.png; skipping regeneration."
else
  node scripts/make-icons.mjs
fi

# Build one fpk per architecture. fnOS packages are single-arch (manifest
# platform=x86|arm), and the runtime tree embeds arch-specific native modules
# (node-pty/koffi/ripgrep), so we cannot use platform=all. Each iteration
# fetches (if needed), rewrites, packs the arch's runtime tar, then fnpacks a
# self-contained fpk carrying that arch's runtime.tar.gz.
#
# Architectures (DSH_ARCH values used by the scripts): x86_64 | arm64.
# fnOS manifest platform mapping: x86_64 -> x86, arm64 -> arm.
# Set DSH_ARCHS to a space-separated subset to build fewer (default: both).
DSH_ARCHS="${DSH_ARCHS:-x86_64 arm64}"

for arch in $DSH_ARCHS; do
  case "$arch" in
    x86_64) pkg_platform="x86"; suffix="x86" ;;
    arm64)  pkg_platform="arm"; suffix="arm" ;;
    *) echo "unsupported DSH_ARCH: $arch" >&2; exit 1 ;;
  esac
  echo "=== Building architecture: ${arch} (manifest platform=${pkg_platform}) ==="

  # Same-version rebuilds skip the install when the runtime tree is already
  # staged. The whole dependency set is compared (dsh + pnpm; the market
  # plugin is no longer vendored — it installs online at first boot), so
  # bumping any pin in package.json re-fetches the tree.
  staged=$(node -p "try{const d=require('./cache/dsh-runtime-${arch}/package.json').dependencies,p=require('./package.json');JSON.stringify(d)===JSON.stringify({'@deepseek-ai/dsh':p.dshVersion,pnpm:p.pnpmVersion})}catch{false}" 2>/dev/null || true)
  if [ "$staged" = true ] && [ -f "cache/dsh-runtime-${arch}/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
    echo "Runtime for ${version} (${arch}) already staged; skipping install."
  else
    DSH_ARCH="$arch" node scripts/fetch-dsh.mjs
  fi

  DSH_ARCH="$arch" node scripts/rewrite-dist.mjs
  DSH_ARCH="$arch" node scripts/pack-runtime.mjs

  # Place this arch's runtime tar where install_callback expects it. fnpack
  # packs the whole src/app tree, so keep ONLY runtime.tar.gz in there — a
  # stray arch tar would ship 60+ MB of dead weight inside the fpk (this bit
  # us once: both arch tars ended up inside both fpks).
  rm -f src/app/runtime.tar.gz src/app/runtime-*.tar.gz
  cp "cache/runtime-${arch}.tar.gz" "src/app/runtime.tar.gz"

  # Stamp the manifest with this arch's platform, then fnpack.
  sed -i "s/^platform=.*/platform=${pkg_platform}/" src/manifest
  (cd src && fnpack build)

  appver=$(sed -n 's/^version=//p' src/manifest | head -1 | tr -d '[:space:]')
  mkdir -p dist
  out="dist/dsh_${appver}_${suffix}.fpk"
  # Move (not copy) so src/ holds no fpk after the build.
  mv src/dsh.fpk "$out"
  printf 'app: %s\ndsh: %s\narch: %s\nplatform: %s\nbuilt: %s\n' "$appver" "$version" "$arch" "$pkg_platform" "$(date '+%Y-%m-%d %H:%M:%S')" > "${out}.info.txt"
  echo "Built ${out}"
done

# Restore platform to x86 in the committed manifest (the default build target
# is this x86 host); builders override per-run via DSH_ARCHS.
sed -i "s/^platform=.*/platform=x86/" src/manifest
