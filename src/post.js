import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Post stack, merged to the minimum number of full-screen passes:
//   Scene : MSAA render, sanitised once (NaN / Inf / negatives) (see MsaaScenePass)
//   Pre   : screen-space light shafts                         (HDR in → HDR out)
//   Bloom : UnrealBloomPass                                   (HDR)
//   Final : lens flare + ACES tone mapping + sRGB + barrel distortion, chromatic
//           aberration, baked frost, vignette and grain       (HDR in → display)
// The frost layer is static, so it is baked to a texture on resize instead of
// evaluating five-octave noise for every pixel every frame.

const FS_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

/** Chromatic aberration with the lens effects on (Options › Graphics). */
export const CHROMATIC_ON = 0.83;

export const PreShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector3(0.5, 0.5, 0) }, // xy uv, z = on-screen weight
    uSunColor: { value: new THREE.Color(1, 0.6, 0.3) },
    uIntensity: { value: 0.55 },
    uAspect: { value: 1 },
    uTime: { value: 0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec3 uSun; uniform vec3 uSunColor; uniform float uIntensity; uniform float uAspect; uniform float uTime;
    varying vec2 vUv;
    float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main(){
      // the input is already sanitised by the scene pass
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (uSun.z <= 0.001 || uIntensity <= 0.0) { gl_FragColor = vec4(base, 1.0); return; }
      const int N = 40;
      vec2 delta = (uSun.xy - vUv) / float(N) * 0.85;
      vec2 uv = vUv + delta * ign(gl_FragCoord.xy + uTime * 60.0);
      float decay = 1.0, acc = 0.0;
      for (int i = 0; i < N; i++) {
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        acc += smoothstep(1.2, 6.0, l) * decay;
        decay *= 0.965;
        uv += delta;
      }
      acc /= float(N);
      vec2 d = (vUv - uSun.xy) * vec2(uAspect, 1.0);
      float fall = exp(-length(d) * 1.6);
      gl_FragColor = vec4(base + uSunColor * acc * fall * uIntensity * uSun.z * 6.0, 1.0);
    }`,
};

// Baked once per resize: R frost mask, G crystal pattern, BA refraction offset.
const FrostBakeShader = {
  uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uFrost: { value: 0.4 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform vec2 uRes; uniform float uFrost; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
    // feathery frost: fern-like branches growing out of the nearest frame corner
    float frostPattern(vec2 uv, vec2 asp){
      vec2 corner = vec2(step(0.5, uv.x), step(0.5, uv.y));
      vec2 d = (uv - corner) * asp;
      float r = length(d);
      float a = atan(d.y, d.x);
      // main spines: thin ridges along radial lines, wavering
      float spines = 0.0;
      vec2 q = vec2(a * 9.0 + noise(vec2(r * 6.0, a * 3.0)) * 1.2, r * 3.0);
      float sp = abs(fract(q.x) - 0.5);
      spines = 1.0 - smoothstep(0.0, 0.06, sp);
      // side branches: short ridges at ~60° to the spine
      vec2 qb = vec2(q.x * 3.0 + r * 40.0, r);
      float br = 1.0 - smoothstep(0.0, 0.12, abs(fract(qb.x) - 0.5));
      br *= smoothstep(0.25, 0.5, noise(vec2(a * 30.0, r * 25.0)));
      // fine crystalline grain
      float grain = smoothstep(0.62, 0.9, noise(uv * asp * 220.0));
      return clamp(spines * 0.7 + br * 0.5 + grain * 0.35, 0.0, 1.0);
    }

    void main(){
      vec2 asp = vec2(uRes.x / uRes.y, 1.0);
      vec2 cc = abs(vUv - 0.5) * 2.0;
      float corner = pow(cc.x * cc.y, 0.75) * 0.55 + pow(max(cc.x, cc.y), 6.0) * 0.45;
      float edge = corner + (fbm(vUv * 6.0) - 0.5) * 0.35;
      float fp = edge > 0.2 ? frostPattern(vUv, asp) : 0.0;
      vec2 refr = edge > 0.2 ? (vec2(fbm(vUv * 40.0), fbm(vUv * 40.0 + 9.0)) - 0.5) : vec2(0.0);
      gl_FragColor = vec4(clamp(edge / 1.5, 0.0, 1.0), fp, refr * 0.5 + 0.5);
    }`,
};

export const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    tFrost: { value: null },
    uExposure: { value: 0.5 },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFisheye: { value: 0.06 },
    uCA: { value: 0.7 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.025 },
    uCocMax: { value: 0.0105 }, // largest blur disc (screen heights); photo mode allows more
    uLook: { value: 0 }, // photo looks: 0 natural · 1 black & white · 2 warm · 3 cool
    uSun: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uSunColor: { value: new THREE.Color(1, 0.6, 0.3) },
    uIntensity: { value: 1.0 },
    uAspect: { value: 1 },
    uCold: { value: 0 },
    uFrost: { value: 0.4 },
    tDepth: { value: null },
    uClip: { value: new THREE.Vector2(0.03, 4200) },
    uFocus: { value: 2 },
    uAperture: { value: 0.006 }, // background blur as a fraction of screen height, at 1 m focus
    uFarBlur: { value: 0.0035 }, // distance softness for the far field
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform sampler2D tFrost; uniform float uCold; uniform float uFrost;
    uniform highp sampler2D tDepth; uniform vec2 uClip; uniform float uFocus; uniform float uAperture; uniform float uFarBlur;
    uniform float uExposure; uniform float uTime; uniform vec2 uRes; uniform float uFisheye; uniform float uCA; uniform float uLook; uniform float uVignette; uniform float uGrain; uniform float uCocMax;
    uniform vec3 uSun; uniform vec3 uSunColor; uniform float uIntensity; uniform float uAspect;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float disc(vec2 p, float r, float soft) { return smoothstep(r, r * (1.0 - soft), length(p)); }
    vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 color) {
      const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color *= uExposure / 0.6;
      color = ACESOutputMat * RRTAndODTFit(ACESInputMat * color);
      return clamp(color, 0.0, 1.0);
    }
    vec3 clean(vec3 c) {
      bool bad = any(isnan(c)) || any(isinf(c)) || !(c.r >= -1.0 && c.g >= -1.0 && c.b >= -1.0 && c.r < 60000.0 && c.g < 60000.0 && c.b < 60000.0);
      // negatives too: the ACES fit has a pole just below zero (pink/yellow blots)
      return bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(2000.0));
    }
    // DoF tap: finite, non-negative, firefly-clamped
    // (the input is finite and non-negative: the scene pass sanitised it once)
    vec3 tap(vec2 uv) { return min(texture2D(tDiffuse, uv).rgb, vec3(12.0)); }
    vec3 srgb(vec3 c) { return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }

    // analytic lens flare (ghosts, chromatic halo, streak, starburst) at a given uv
    vec3 flareAt(vec2 vUv, float vis) {
      vec2 asp = vec2(uAspect, 1.0);
      vec2 sun = uSun.xy;
      vec2 axis = vec2(0.5) - sun;
      vec3 flare = vec3(0.0);
      float gpos[5]; gpos[0] = 0.55; gpos[1] = 0.9; gpos[2] = 1.25; gpos[3] = 1.55; gpos[4] = 2.1;
      float gsz[5];  gsz[0] = 0.035; gsz[1] = 0.06; gsz[2] = 0.022; gsz[3] = 0.11; gsz[4] = 0.05;
      vec3 gcol[5];
      gcol[0] = vec3(0.9, 0.6, 0.3); gcol[1] = vec3(0.3, 0.6, 0.9); gcol[2] = vec3(0.9, 0.9, 0.5); gcol[3] = vec3(0.5, 0.35, 0.8); gcol[4] = vec3(0.3, 0.8, 0.6);
      for (int i = 0; i < 5; i++) {
        vec2 c = sun + axis * gpos[i];
        vec2 p = (vUv - c) * asp;
        float ring = disc(p, gsz[i], 0.35) * (0.35 + 0.65 * smoothstep(gsz[i] * 0.5, gsz[i], length(p)));
        flare += gcol[i] * ring * 0.012;
      }
      vec2 ph = (vUv - sun) * asp;
      float r = length(ph);
      // squares, never pow(): pow() of a negative base is undefined in GLSL and turns
      // into NaN on some drivers (a black disc the size of the halo around the sun)
      vec3 hd = (vec3(r) - vec3(0.255, 0.25, 0.245)) / 0.012;
      vec3 haloC = exp(-hd * hd);
      flare += haloC * 0.05;
      float streak = exp(-abs(ph.y) * 260.0) * exp(-abs(ph.x) * 3.2);
      float ang = atan(ph.y, ph.x);
      float star = pow(abs(cos(ang * 3.0)), 60.0) * exp(-r * 12.0) + pow(abs(cos(ang * 3.0 + 0.52)), 80.0) * exp(-r * 18.0) * 0.6;
      flare += vec3(1.0, 0.75, 0.55) * streak * 0.5 + vec3(1.0, 0.85, 0.7) * star * 0.9;
      flare += exp(-r * 5.0) * 0.12;
      return flare * uSunColor * vis * uIntensity * 4.0;
    }

    float linDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - z * (uClip.y - uClip.x));
    }
    // circle of confusion, in screen heights: thin-lens falloff around the focus plane,
    // plus a gentle softening of the far distance (atmosphere / long lens)
    float cocAt(float d) {
      float lens = uAperture / max(uFocus, 0.3) * (d - uFocus) / max(d, 0.05);
      float far = uFarBlur * smoothstep(60.0, 650.0, d);
      return clamp(abs(lens) + far, 0.0, uCocMax);
    }
    void main(){
      vec2 asp = vec2(uRes.x / uRes.y, 1.0);
      vec2 c = (vUv - 0.5) * asp;
      float r2 = dot(c, c);
      vec2 dist = c * (1.0 + uFisheye * r2) / (1.0 + uFisheye * 0.35);
      vec4 frost = texture2D(tFrost, vUv);
      float frostMask = smoothstep(1.0 - uFrost * 0.75, 1.15 - uFrost * 0.6, frost.r * 1.5) * step(0.001, uFrost);
      vec2 refr = (frost.ba - 0.5) * 0.024 * frostMask;
      vec2 uvD = dist / asp + 0.5 + refr;
      float ca = uCA * 0.012 * r2;
      vec2 dir = c / asp;
      vec3 hdr;
      float dC = linDepth(uvD);
      float coc = cocAt(dC);
      if (coc * uRes.y > 0.75) {
        // depth of field: golden-angle disc gather; taps nearer than this pixel only
        // contribute as much as they are themselves out of focus (no sharp halos)
        vec3 acc = tap(uvD);
        float wsum = 1.0;
        // interleaved-gradient rotation: smooth blue-ish noise instead of white speckle
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
        for (int i = 0; i < 20; i++) {
          float fi = float(i) + 0.5;
          float rr = sqrt(fi / 20.0) * coc;
          float an = fi * 2.39996323 + jitter;
          vec2 o = vec2(cos(an) / asp.x, sin(an)) * rr;
          float dT = linDepth(uvD + o);
          float w = dT >= dC - 0.02 * dC ? 1.0 : clamp(cocAt(dT) / coc, 0.0, 1.0);
          // clamp fireflies: a few very bright glints would otherwise print the tap pattern
          acc += tap(uvD + o) * w;
          wsum += w;
        }
        hdr = acc / wsum;
      } else {
        // lens-edge chromatic aberration: the centre stays clean, a fringe grows toward
        // the rim of the frame (one tap per channel, so nothing smears)
        float m = smoothstep(0.34, 0.95, length(c));
        vec2 o = dir * uCA * 0.0056 * m * m;
        hdr = vec3(texture2D(tDiffuse, uvD - o).r, texture2D(tDiffuse, uvD).g, texture2D(tDiffuse, uvD + o).b);
      }
      hdr = clean(hdr);
      if (uSun.z > 0.001 && uIntensity > 0.0) {
        // occlusion: how much of the sun neighbourhood is actually bright
        float vis = 0.0;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5236;
          vec2 o = vec2(cos(a), sin(a) * uAspect) * 0.006 * (1.0 + float(i & 1));
          vis += smoothstep(2.0, 8.0, dot(texture2D(tDiffuse, uSun.xy + o).rgb, vec3(0.2126, 0.7152, 0.0722)));
        }
        vis = vis / 12.0 * uSun.z;
        if (vis > 0.001) hdr = clean(hdr + flareAt(uvD, vis));
      }
      vec3 col = srgb(aces(hdr));
      // cold: colour drains toward a blue-grey and the frame closes in
      float cl = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(cl) * vec3(0.86, 0.93, 1.06), uCold * 0.75);
      col *= 1.0 - uCold * 0.45 * smoothstep(0.15, 0.9, length(c));
      vec3 frostTint = vec3(0.86, 0.93, 1.0);
      col = mix(col, col * 0.8 + frostTint * 0.16, frostMask * 0.7);
      col += frostTint * frost.g * frostMask * 0.32;
      col *= 1.0 - uVignette * smoothstep(0.2, 1.1, length(c) * 1.15);
      if (uLook > 0.5) {
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        if (uLook < 1.5) col = vec3(smoothstep(0.02, 0.98, lum)); // silver print: a touch more contrast
        else if (uLook < 2.5) col = clamp(col * vec3(1.07, 1.0, 0.88) + vec3(0.015, 0.006, 0.0), 0.0, 1.0);
        else col = clamp(col * vec3(0.9, 0.99, 1.1), 0.0, 1.0);
      }
      col += (hash(vUv * uRes + fract(uTime * 13.7) * 100.0) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class FrostBaker {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    this.material = new THREE.ShaderMaterial({ ...FrostBakeShader, uniforms: THREE.UniformsUtils.clone(FrostBakeShader.uniforms), depthTest: false, depthWrite: false });
    this.scene = new THREE.Scene();
    const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    q.frustumCulled = false;
    this.scene.add(q);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.key = '';
  }
  bake(w, h) {
    const key = `${w}x${h}`;
    if (key === this.key) return;
    this.key = key;
    this.rt.setSize(w, h);
    this.material.uniforms.uRes.value.set(w, h);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }
  get texture() { return this.rt.texture; }
}
/** Sun position on screen (uv) + weight (fades when off-screen / behind camera). */
export function sunScreen(camera, sunDir, out) {
  const p = _p.copy(camera.position).addScaledVector(sunDir, 5000).project(camera);
  const behind = _d.copy(sunDir).dot(camera.getWorldDirection(_w)) <= 0;
  if (behind) return out.set(0.5, 0.5, 0);
  const u = p.x * 0.5 + 0.5, v = p.y * 0.5 + 0.5;
  const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
  return out.set(u, v, THREE.MathUtils.clamp(1.6 - edge, 0, 1));
}
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _w = new THREE.Vector3();

/**
 * The scene, rendered with MSAA into its own HDR target (with depth), then copied once into
 * the composer's plain (non-multisampled) buffers. Only the scene needs antialiasing: the
 * full-screen passes after it (light shafts, bloom, final) would otherwise each write to
 * a 4× multisampled target and pay for a resolve every time, for no visible difference.
 */
export class MsaaScenePass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene; this.camera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, stencilBuffer: false, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FS_VERT,
      // the one place the HDR scene is sanitised (NaN/Inf/negatives → 0, capped): every
      // pass after it reads finite, non-negative colour and need not check each tap again
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          bool bad = any(isnan(c)) || any(isinf(c)) || !(c.r >= -1.0 && c.g >= -1.0 && c.b >= -1.0 && c.r < 60000.0 && c.g < 60000.0 && c.b < 60000.0);
          gl_FragColor = vec4(bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(2000.0)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.copy.material.uniforms.tDiffuse.value = this.target.texture;
  }
  get depthTexture() { return this.target.depthTexture; }
  setSamples(n) { if (this.target.samples !== n) { this.target.samples = n; this.target.dispose(); } }
  setSize(w, h) { this.target.setSize(w, h); }
  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(writeBuffer);
    this.copy.render(renderer);
    // overlays that read the scene depth (soft blowing snow): drawn over the copy
    if (this.overlay?.visible !== false && this.overlay?.children.length) {
      this.onOverlay?.(this.target, writeBuffer);
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(this.overlay, this.camera);
      renderer.autoClear = ac;
    }
  }
  dispose() { this.target.dispose(); this.copy.dispose(); }
}

/** Hands the scene depth (resolved from the MSAA target) to a later pass. */
export class DepthTapPass extends Pass {
  constructor(uniform) { super(); this.uniform = uniform; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) { this.uniform.value = this.source?.depthTexture ?? readBuffer.depthTexture; }
}
