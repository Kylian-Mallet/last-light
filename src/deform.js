import * as THREE from 'three';

// Snow deformation field --------------------------------------------------
// A world-space render target over the walkable area. R = compression depth (m),
// G = displaced rim height (m). Stamps blend with MAX so overlapping prints keep
// the deepest imprint; wind refill multiplies the field toward zero over time.

export const DEFORM_EXTENT = 44; // metres, centred on origin

const STAMP_VERT = /* glsl */`
  uniform float uExtent;
  varying vec2 vLocal;
  void main() {
    vLocal = position.xz;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    gl_Position = vec4(wp.x / (uExtent * 0.5), wp.z / (uExtent * 0.5), 0.0, 1.0);
  }
`;

const STAMP_FRAG = /* glsl */`
  uniform int uType;       // 0 foot, 1 drag, 2 belly
  uniform float uDepth;
  uniform float uRim;
  uniform float uSeed;
  uniform vec2 uSize;      // local half extents (m)
  uniform float uFoot;     // foot scale (1 = chick)
  varying vec2 vLocal;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.13) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float sdCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - mix(ra, rb, h);
  }
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  void main() {
    // local frame: x lateral, y forward (stamp mesh +Z maps to forward)
    vec2 p = vec2(vLocal.x, vLocal.y) * uSize * 2.0;
    float depth = 0.0, rim = 0.0;
    // crumbly edge breakup: snow does not fail along a perfect contour
    float crumble = (vnoise(p * 900.0) - 0.5) * 0.0025 + (vnoise(p * 260.0) - 0.5) * 0.002;

    if (uType == 0) {
      // emperor foot: heel pad + three webbed toes with claws. The shape is drawn at chick
      // size and scaled by uFoot (an adult's foot is about twice as long)
      p /= uFoot;
      vec2 heel = vec2(0.0, -0.016);
      float dHeel = length((p - heel) / vec2(1.0, 1.25)) - 0.0155;
      vec2 root = vec2(0.0, -0.004);
      vec2 tM = vec2(0.0, 0.040), tL = vec2(-0.025, 0.031), tR = vec2(0.025, 0.031);
      float dT = sdCapsule(p, root, tM, 0.0075, 0.0042);
      dT = min(dT, sdCapsule(p, root, tL, 0.0072, 0.0038));
      dT = min(dT, sdCapsule(p, root, tR, 0.0072, 0.0038));
      // webbing: shallow fill between toes
      float web = max(length(p - root) - 0.031, -(p.y - 0.0 + abs(p.x) * 0.25));
      float d = smin(dHeel, dT, 0.006) + crumble;
      float inside = smoothstep(0.0012, -0.003, d);
      float profile = mix(0.72, 1.0, smoothstep(0.02, -0.02, p.y)); // heel bears weight
      depth = uDepth * inside * profile;
      depth = max(depth, uDepth * 0.35 * smoothstep(0.002, -0.004, web + crumble));
      // claws punch slightly deeper just beyond each toe tip
      vec2 cM = tM + vec2(0.0, 0.006), cL = tL + normalize(tL - root) * 0.006, cR = tR + normalize(tR - root) * 0.006;
      float dc = min(length(p - cM), min(length(p - cL), length(p - cR))) - 0.0022;
      depth = max(depth, uDepth * 1.1 * smoothstep(0.0008, -0.0012, dc));
      // displaced snow lifts into a soft rim, pushed forward by the step
      float dOut = max(d, 0.0);
      float push = 1.0 + 0.6 * smoothstep(-0.01, 0.04, p.y);
      rim = uRim * push * exp(-dOut / 0.006) * smoothstep(-0.001, 0.003, d) * (0.7 + 0.6 * vnoise(p * 400.0));
    } else if (uType == 1) {
      // toe drag between steps: thin furrow
      float d = abs(p.x + 0.002 * sin(p.y * 180.0)) - 0.0035 * smoothstep(-uSize.y * 2.0, uSize.y * 2.0, p.y + uSize.y);
      d += crumble * 0.6;
      float along = smoothstep(uSize.y * 2.0, uSize.y * 1.2, abs(p.y));
      depth = uDepth * smoothstep(0.001, -0.002, d) * along;
      rim = uRim * exp(-max(d, 0.0) / 0.004) * along * 0.6;
    } else {
      // belly toboggan trough: rounded profile, rims along both sides
      vec2 q = p / uSize;
      float r = length(q * vec2(1.0, 0.75));
      float inside = sqrt(clamp(1.0 - r * r, 0.0, 1.0));
      depth = uDepth * inside * (0.9 + 0.2 * vnoise(p * 60.0));
      float side = smoothstep(0.75, 1.05, abs(q.x)) * smoothstep(1.6, 1.05, abs(q.x)) * smoothstep(1.2, 0.6, abs(q.y));
      rim = uRim * side * (0.6 + 0.8 * vnoise(p * 50.0));
    }
    gl_FragColor = vec4(depth, rim, 0.0, 1.0);
  }
`;

export class SnowDeformer {
  constructor(renderer, size = 4096) {
    this.renderer = renderer;
    this.size = size;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); // XZ plane, -0.5..0.5
    // PlaneGeometry rotated: local +Y became -Z; flip so stamp forward is +Z
    this.geo.scale(1, 1, -1);
    this.pool = [];
    this.pending = [];
    this.decayAccum = 0;

    this.fillMat = new THREE.ShaderMaterial({
      uniforms: { uFactor: { value: 1 } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
      fragmentShader: 'uniform float uFactor; void main(){ gl_FragColor = vec4(uFactor, uFactor, 1.0, 1.0); }',
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.fillQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fillMat);
    this.fillQuad.frustumCulled = false;
    this.fillScene = new THREE.Scene();
    this.fillScene.add(this.fillQuad);

    this.clear();
  }

  clear() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prev);
    r.setClearColor(cc, ca);
  }

  makeStampMesh() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uExtent: { value: DEFORM_EXTENT },
        uType: { value: 0 },
        uDepth: { value: 0.02 },
        uRim: { value: 0.004 },
        uSeed: { value: 0 },
        uSize: { value: new THREE.Vector2(0.06, 0.06) },
        uFoot: { value: 1 },
      },
      vertexShader: STAMP_VERT,
      fragmentShader: STAMP_FRAG,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const m = new THREE.Mesh(this.geo, mat);
    m.frustumCulled = false;
    return m;
  }

  /**
   * Queue a stamp. type: 'foot' | 'drag' | 'belly'. heading: radians (forward = (sin h, cos h)).
   */
  stamp(type, x, z, heading, { depth = 0.02, rim = 0.004, halfW = 0.06, halfL = 0.06 } = {}) {
    const m = this.pool.pop() || this.makeStampMesh();
    const u = m.material.uniforms;
    u.uType.value = type === 'foot' ? 0 : type === 'drag' ? 1 : 2;
    u.uDepth.value = depth;
    u.uRim.value = rim;
    u.uSeed.value = Math.random() * 100;
    u.uSize.value.set(halfW, halfL);
    u.uFoot.value = type === 'foot' ? halfW / 0.05 : 1; // prints are drawn at chick size (halfW 0.05)
    m.position.set(x, 0, z);
    m.rotation.set(0, heading, 0);
    m.scale.set(halfW * 2, 1, halfL * 2);
    this.pending.push(m);
  }

  /** Flush pending stamps and apply wind refill. */
  update(dt, refillRate) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    if (this.pending.length) {
      for (const m of this.pending) this.scene.add(m);
      r.setRenderTarget(this.rt);
      r.render(this.scene, this.camera);
      for (const m of this.pending) {
        this.scene.remove(m);
        this.pool.push(m);
      }
      this.pending.length = 0;
    }
    // Half floats cannot represent tiny per-frame decay, so batch it.
    this.decayAccum += dt * refillRate;
    if (this.decayAccum > 0.012) {
      this.fillMat.uniforms.uFactor.value = Math.exp(-this.decayAccum);
      this.decayAccum = 0;
      r.setRenderTarget(this.rt);
      r.render(this.fillScene, this.camera);
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
  }

  get texture() {
    return this.rt.texture;
  }
}
