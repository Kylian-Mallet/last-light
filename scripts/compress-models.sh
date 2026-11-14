#!/usr/bin/env bash
# Rebuild the compressed character models (public/models/) from the original exports
# (assets/models/):
#   1. WebP textures (quality 92)
#   2. Draco geometry, high precision (16-bit positions, 12-bit normals and skin weights,
#      14-bit UVs), so skinning and the down shells are unchanged once decoded
# KTX2 textures were measured and dropped: a larger download, a slower load and no faster
# frames for this game.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=.glbtmp
mkdir -p "$tmp" public/models
for m in penguin adult adult_crowd chick_a chick_b fish; do
  npx gltf-transform webp "assets/models/$m.glb" "$tmp/$m.webp.glb" --quality 92
  npx gltf-transform draco "$tmp/$m.webp.glb" "public/models/$m.glb" \
    --quantize-position 16 --quantize-normal 12 --quantize-texcoord 14 --quantize-generic 12
done
rm -r "$tmp"
