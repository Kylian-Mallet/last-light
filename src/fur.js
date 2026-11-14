import * as THREE from 'three';
import { PENGUIN_UNIFORMS } from './penguin.js';
import { weldPositions } from './util.js';

// Shell-textured down for the skinned chick.
// N copies of the skinned mesh are pushed out along the skinned normal; each shell
// keeps only the pixels that belong to a strand at that height. Strands are hashed
// from the rest-pose position (3D), so density is uniform despite Meshy's fragmented UVs.

const FUR_VERT_PARS = /* glsl */`
  attribute float aFur;
  attribute vec3 aFurN;
  attribute float aLayer; // per instance: shell height 0..1
  uniform float uFurLen;
  uniform mat4 uWorldToObj;
  uniform vec3 uForceW;   // gravity + inertia + wind, world space (m per m of length)
  varying vec3 vRest;
  varying vec3 vRestN;
  varying float vLayer;
  varying float vFur;
`;

const FUR_VERT_DISPLACE = /* glsl */`
  {
    vec3 nW = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
    float len = uFurLen * aFur * aLayer;
    // strands droop and trail with motion, more toward their tips
    vec3 offW = nW * len + uForceW * len * aLayer;
    transformed += (uWorldToObj * vec4(offW, 0.0)).xyz;
    vRest = position;
    vRestN = normal;
    vLayer = aLayer;
    vFur = aFur;
  }
`;

const FUR_FRAG_PARS = /* glsl */`
  uniform float uDensity;
  uniform vec3 uSunDirV;
  uniform vec3 uSunRad;
  uniform vec2 uTone;
  uniform float uSnowCover;
  varying vec3 vRest;
  varying vec3 vRestN;
  varying float vLayer;
  varying float vFur;
  vec3 furHash(vec3 p) {
    p = fract(p * vec3(.1031, .1030, .0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  // distance to the nearest jittered strand centre in a 3D cell lattice (2x2x2 search)
  float strand(vec3 p, out vec3 rnd) {
    vec3 c = floor(p);
    vec3 f = fract(p);
    vec3 base = c - step(0.5, f);
    float best = 9.0;
    rnd = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      vec3 cell = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
      vec3 h = furHash(cell);
      vec3 d = cell + 0.2 + h * 0.6 - p;
      float dd = dot(d, d);
      if (dd < best) { best = dd; rnd = h; }
    }
    return sqrt(best);
  }
`;

const FUR_FRAG_MASK = /* glsl */`
  {
    if (vFur < 0.02) discard;
    vec3 rnd;
    float d = strand(vRest * uDensity, rnd);
    float len1 = 0.45 + 0.55 * rnd.z;
    float r1 = mix(0.5, 0.08, vLayer / len1);
    bool hit1 = vLayer < len1 && d < r1;
    if (!hit1) {
      // second, finer layer of wisps (only evaluated where the main strands miss)
      vec3 rnd2;
      float d2 = strand(vRest * uDensity * 2.3 + 7.1, rnd2);
      float len2 = 0.3 + 0.5 * rnd2.y;
      float r2 = mix(0.45, 0.07, vLayer / len2);
      if (!(vLayer < len2 && d2 < r2)) discard;
    }
  }
`;

export class Fur {
  /**
   * All shells are one instanced draw. For the hero they read the GPU-skinned vertices
   * (see gpuskin.js): the chick is skinned once per frame however many shells are drawn.
   * skinner: a GpuSkinner (hero: skinned once, shells read textures) or null (colony
   * chicks: a SkinnedMesh drawn with instanced shells, skinned in the vertex shader).
   * tone/even: target grey and how strongly the coat is evened toward it (hero only).
   * maskMode: 'color' follows the plumage colours around the head, 'bones' just bares the head.
   */
  constructor(skinnedMesh, skinner, { shells = 14, length = 0.016, density = 720, tone = 0.52, even = 0.4, maskMode = 'color', lodDistance = 7 } = {}) {
    this.base = skinnedMesh;
    this.count = shells;
    this.lodDistance = lodDistance;
    this.maskMode = maskMode;
    this.uniforms = {
      uFurLen: { value: length },
      uWorldToObj: { value: new THREE.Matrix4() },
      uForceW: { value: new THREE.Vector3(0, -0.35, 0) },
      uDensity: { value: density },
      uTone: { value: new THREE.Vector2(tone, even) },
      uSunDirV: PENGUIN_UNIFORMS.uSunDirV,
      uSunRad: PENGUIN_UNIFORMS.uSunRad,
    };
    if (!skinnedMesh.geometry.attributes.aFur) this.computeMask();
    if (!skinnedMesh.geometry.attributes.aFurN) skinnedMesh.geometry.setAttribute('aFurN', smoothNormals(skinnedMesh.geometry, skinner ? 70 : 12));
    skinner?.setFurNormal(skinnedMesh.geometry.attributes.aFurN);
    const src = skinnedMesh.geometry;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(src.index);
    const attrs = skinner ? ['position', 'normal', 'uv', 'aFur'] : ['position', 'normal', 'uv', 'aFur', 'aFurN', 'skinIndex', 'skinWeight'];
    for (const k of attrs) geo.setAttribute(k, src.attributes[k]);
    this.layers = new Float32Array(shells);
    for (let i = 0; i < shells; i++) this.layers[i] = (i + 1) / shells;
    this.layerAttr = new THREE.InstancedBufferAttribute(this.layers, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aLayer', this.layerAttr);
    geo.instanceCount = shells;
    this.geometry = geo;

    const mat = new THREE.MeshStandardMaterial({
      map: skinnedMesh.material.map,
      roughness: 0.9,
      metalness: 0,
      side: THREE.FrontSide,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, { uSnowCover: PENGUIN_UNIFORMS.uSnowCover });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + FUR_VERT_PARS)
        .replace('#include <beginnormal_vertex>', skinner ? '#include <beginnormal_vertex>' : 'vec3 objectNormal = normalize(aFurN);')
        .replace('#include <project_vertex>', FUR_VERT_DISPLACE + '\n#include <project_vertex>');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FUR_FRAG_PARS)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + FUR_FRAG_MASK)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // deep down is occluded by the strands above it; tips catch light and look paler
          diffuseColor.rgb *= mix(0.68, 1.04, vLayer);
          // down is silver-grey: neutralise the warm cast and even out the baked texture's
          // blotches (Meshy atlas) so the coat reads as one continuous fleece
          float furL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          vec3 furGrey = vec3(mix(furL, uTone.x * mix(0.68, 1.04, vLayer), uTone.y)) * vec3(0.97, 0.99, 1.03);
          diffuseColor.rgb = mix(diffuseColor.rgb, furGrey, 0.6 * step(0.001, uTone.y) + 0.25 * (1.0 - step(0.001, uTone.y)));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.15 + 0.03, smoothstep(0.6, 1.0, vLayer));
          // snow caught in the tips of the down during the storm
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.94, 0.96, 0.99), uSnowCover * smoothstep(0.45, 1.0, vLayer) * 0.85);`)
        .replace('#include <opaque_fragment>', `
          {
            // light transmitted through thin strand tips when back-lit
            vec3 Vv = normalize(vViewPosition);
            float back = pow(clamp(dot(Vv, normalize(uSunDirV)), 0.0, 1.0), 4.0);
            outgoingLight += uSunRad * diffuseColor.rgb * back * vLayer * vLayer * 0.14;
          }
          #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'fur-shell-instanced';
    let mesh;
    if (skinner) {
      // shells grow along the skinned, smoothed normal: the sculpted bumps of the dense
      // hero mesh would otherwise comb the down into dark clumps
      skinner.patch(mat, (shader) => {
        shader.vertexShader = shader.vertexShader.replace('texelFetch(tSkinNor, skinCoord(), 0)', 'texelFetch(tSkinFurN, skinCoord(), 0)');
      });
      mesh = new THREE.Mesh(geo, mat);
    } else {
      mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.bind(skinnedMesh.skeleton, skinnedMesh.bindMatrix);
    }
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    skinnedMesh.parent.add(mesh);
    mesh.position.copy(skinnedMesh.position);
    mesh.quaternion.copy(skinnedMesh.quaternion);
    mesh.scale.copy(skinnedMesh.scale);
    this.mesh = mesh;
    this.shells = [mesh]; // visibility toggled as a unit (water reflection pass)
  }

  /** Per-vertex fur length: none on feet, beak and eyes, short on the head. */
  computeMask() {
    const geo = this.base.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const bones = this.base.skeleton.bones;
    const isFoot = bones.map((b) => /Foot|Toe/.test(b.name));
    const isHead = bones.map((b) => /^Head|head|neck/.test(b.name));
    const n = pos.count;
    let fur = new Float32Array(n);

    // Base-colour luminance at each vertex (3x3 averaged): the grey down ends where the
    // white face mask and the black cap begin, exactly like on a real chick.
    let lumAt = null;
    const map = this.base.material.map;
    if (map?.image && uv) {
      const W = 1024, H = 1024;
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(map.image, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const flip = map.flipY !== false;
      lumAt = (u, v) => {
        u -= Math.floor(u); v -= Math.floor(v);
        if (flip) v = 1 - v;
        const cx = Math.floor(u * W), cy = Math.floor(v * H);
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(H - 1, Math.max(0, cy + dy));
          const o = (y * W + x) * 4;
          sum += (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
          cnt++;
        }
        return sum / cnt;
      };
    }

    let headMinY = Infinity;
    const headW = new Float32Array(n), footW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        const b = si.getComponent(i, k), w = sw.getComponent(i, k);
        if (isFoot[b]) footW[i] += w;
        if (isHead[b]) headW[i] += w;
      }
      if (headW[i] > 0.6) headMinY = Math.min(headMinY, pos.getY(i));
    }
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      let f = 1 - THREE.MathUtils.smoothstep(footW[i], 0.15, 0.55);
      if (y < 0.03) f *= THREE.MathUtils.smoothstep(y, 0.012, 0.03);
      // around the head, keep down only where the plumage is grey
      if (this.maskMode === 'bones') {
        // pale chicks: bare the head by bone weight only, taper down the neck
        f *= 1 - THREE.MathUtils.smoothstep(headW[i], 0.3, 0.75);
        fur[i] = f;
        continue;
      }
      const nearHead = Math.max(THREE.MathUtils.smoothstep(headW[i], 0.05, 0.3), THREE.MathUtils.smoothstep(y, headMinY - 0.05, headMinY - 0.02));
      const L0 = nearHead > 0 && lumAt ? lumAt(uv.getX(i), uv.getY(i)) : 0.5;
      if (nearHead > 0 && lumAt) {
        const grey = THREE.MathUtils.smoothstep(L0, 0.17, 0.3) * (1 - THREE.MathUtils.smoothstep(L0, 0.66, 0.76));
        f *= 1 - nearHead + nearHead * grey;
      } else if (nearHead > 0) {
        f *= 1 - nearHead;
      }
      fur[i] = f;
    }

    // Feather the boundary over the surface: weld seam duplicates, then diffuse the
    // mask along mesh edges so strand length tapers over ~1–2 cm instead of stopping.
    const { weld, count: m } = weldPositions(pos);
    let val = new Float32Array(m), cnt = new Float32Array(m);
    for (let i = 0; i < n; i++) { val[weld[i]] += fur[i]; cnt[weld[i]]++; }
    for (let j = 0; j < m; j++) val[j] /= cnt[j];
    const idx = geo.index.array;
    for (let it = 0; it < 6; it++) {
      const acc = new Float32Array(m), c = new Float32Array(m);
      for (let t = 0; t < idx.length; t += 3) {
        const a = weld[idx[t]], b = weld[idx[t + 1]], d = weld[idx[t + 2]];
        acc[a] += val[b] + val[d]; c[a] += 2;
        acc[b] += val[a] + val[d]; c[b] += 2;
        acc[d] += val[a] + val[b]; c[d] += 2;
      }
      for (let j = 0; j < m; j++) if (c[j]) val[j] = val[j] * 0.4 + (acc[j] / c[j]) * 0.6;
    }
    for (let i = 0; i < n; i++) {
      // never grow down where the source said none (face, cap, beak, eyes)
      const v = val[weld[i]];
      // face, cap, eyes and beak stay bare; the feathering only shortens the down on the
      // grey side of the boundary, it never grows strands onto the face
      fur[i] = fur[i] < 0.02 ? 0 : Math.min(fur[i], v * 1.15);
    }
    geo.setAttribute('aFur', new THREE.BufferAttribute(fur, 1));
  }

  /** Change the shell count live (quality preset); total fur height is unchanged. */
  setShells(n) {
    n = Math.max(1, Math.round(n));
    if (n > this.layers.length) {
      this.layers = new Float32Array(n);
      this.layerAttr = new THREE.InstancedBufferAttribute(this.layers, 1).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('aLayer', this.layerAttr);
    }
    this.count = n;
    this.geometry.instanceCount = -1; // forces the layer heights to be rebuilt next update
  }

  update(camera, sunDirView, sunRad, force) {
    const dist = camera.position.distanceTo(this.base.getWorldPosition(_v));
    // fewer shells as the chick gets smaller on screen (same total fur height)
    const n = this.count;
    const keep = dist > this.lodDistance ? 0 : Math.max(3, Math.round(n * THREE.MathUtils.clamp(1.6 / dist, 0.3, 1)));
    this.mesh.visible = this.enabled && keep > 0;
    if (!this.mesh.visible) return;
    if (keep !== this.geometry.instanceCount) {
      for (let i = 0; i < keep; i++) this.layers[i] = (i + 1) / keep;
      this.layerAttr.needsUpdate = true;
      this.geometry.instanceCount = keep;
    }
    this.uniforms.uWorldToObj.value.copy(this.mesh.matrixWorld).invert();
    this.uniforms.uForceW.value.copy(force);
  }

  enabled = true;
}
const _v = new THREE.Vector3();

/**
 * Normals diffused over the welded surface (seams joined): a few millimetres of
 * sculpted relief no longer steers the strands, the coat follows the body's shape.
 */
function smoothNormals(geo, iterations) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const n = pos.count;
  const { weld, count: m } = weldPositions(pos);
  const cur = new Float32Array(m * 3);
  for (let i = 0; i < n; i++) {
    const j = weld[i] * 3;
    cur[j] += nor.getX(i); cur[j + 1] += nor.getY(i); cur[j + 2] += nor.getZ(i);
  }
  // unique edges between welded vertices
  const idx = geo.index.array;
  const edgeSet = new Set();
  const ea = [], eb = [];
  const addEdge = (a, b) => {
    if (a === b) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const k = lo * m + hi;
    if (edgeSet.has(k)) return;
    edgeSet.add(k); ea.push(lo); eb.push(hi);
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = weld[idx[t]], b = weld[idx[t + 1]], c = weld[idx[t + 2]];
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  const A = Int32Array.from(ea), B = Int32Array.from(eb);
  const deg = new Float32Array(m);
  for (let e = 0; e < A.length; e++) { deg[A[e]]++; deg[B[e]]++; }
  const normalize = (v) => {
    for (let j = 0; j < m; j++) {
      const x = v[j * 3], y = v[j * 3 + 1], z = v[j * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      v[j * 3] = x / l; v[j * 3 + 1] = y / l; v[j * 3 + 2] = z / l;
    }
  };
  normalize(cur);
  const acc = new Float32Array(m * 3);
  for (let it = 0; it < iterations; it++) {
    acc.fill(0);
    for (let e = 0; e < A.length; e++) {
      const a = A[e] * 3, b = B[e] * 3;
      acc[a] += cur[b]; acc[a + 1] += cur[b + 1]; acc[a + 2] += cur[b + 2];
      acc[b] += cur[a]; acc[b + 1] += cur[a + 1]; acc[b + 2] += cur[a + 2];
    }
    for (let j = 0; j < m; j++) {
      const d = deg[j];
      if (!d) continue;
      const o = j * 3;
      cur[o] = cur[o] * 0.4 + (acc[o] / d) * 0.6;
      cur[o + 1] = cur[o + 1] * 0.4 + (acc[o + 1] / d) * 0.6;
      cur[o + 2] = cur[o + 2] * 0.4 + (acc[o + 2] / d) * 0.6;
    }
    normalize(cur);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = weld[i] * 3;
    out[i * 3] = cur[j]; out[i * 3 + 1] = cur[j + 1]; out[i * 3 + 2] = cur[j + 2];
  }
  return new THREE.BufferAttribute(out, 3);
}
