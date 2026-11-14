import * as THREE from 'three';

// Kicked-up powder: short-lived clumps and fine dust thrown by steps and tobogganing.
// CPU-integrated (gravity, drag, wind), drawn as soft lit sprites.

const MAX = 2400;

export class SnowSpray {
  constructor() {
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX); // remaining
    this.maxLife = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(new Float32Array(MAX * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aData', this.dataAttr);
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRad: { value: new THREE.Color() },
      uSkyTint: { value: new THREE.Color() },
      uPixelRatio: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec2 aData; // x: life fraction (1 → 0), y: size (m)
        uniform float uPixelRatio;
        varying float vLife;
        varying vec3 vWorld;
        void main() {
          vLife = aData.x;
          vWorld = position;
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float px = aData.y * projectionMatrix[1][1] * 0.5 / max(-mv.z, 0.02);
          gl_PointSize = clamp(px * 1080.0 * uPixelRatio * 0.5, 1.0, 64.0) * step(0.0001, aData.x);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSunDir; uniform vec3 uSunRad; uniform vec3 uSkyTint;
        varying float vLife; varying vec3 vWorld;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c);
          if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.15, r) * smoothstep(0.0, 0.25, vLife) * 0.85;
          vec3 V = normalize(vWorld - cameraPosition);
          float fwd = pow(clamp(dot(V, normalize(uSunDir)), 0.0, 1.0), 5.0);
          vec3 col = uSunRad * (0.22 + 1.6 * fwd) + uSkyTint * 0.9;
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(origin, dir, count, { speed = 0.6, spread = 0.6, up = 0.6, size = 0.006, life = 0.8 } = {}) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX;
      const k = i * 3;
      this.pos[k] = origin.x + (Math.random() - 0.5) * 0.04;
      this.pos[k + 1] = origin.y + Math.random() * 0.01;
      this.pos[k + 2] = origin.z + (Math.random() - 0.5) * 0.04;
      const sp = speed * (0.3 + Math.random() * 0.9);
      this.vel[k] = (dir.x + (Math.random() - 0.5) * spread * 2) * sp;
      this.vel[k + 1] = (up * (0.5 + Math.random())) * sp + 0.15;
      this.vel[k + 2] = (dir.z + (Math.random() - 0.5) * spread * 2) * sp;
      const l = life * (0.5 + Math.random() * 0.8);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.size[i] = size * (0.4 + Math.random() * 1.6);
    }
  }

  update(dt, wind, groundAt, sunDir, sunRad, skyTint, pixelRatio) {
    const data = this.dataAttr.array;
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { data[i * 2] = 0; continue; }
      any = true;
      const k = i * 3;
      this.life[i] -= dt;
      const drag = Math.exp(-dt * (3.5 / (0.5 + this.size[i] * 100)));
      this.vel[k] = (this.vel[k] - wind.x) * drag + wind.x;
      this.vel[k + 2] = (this.vel[k + 2] - wind.z) * drag + wind.z;
      this.vel[k + 1] = this.vel[k + 1] * drag - 9.81 * dt * (0.25 + this.size[i] * 60);
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const g = groundAt(this.pos[k], this.pos[k + 2]);
      if (this.pos[k + 1] < g) { this.pos[k + 1] = g; this.life[i] = Math.min(this.life[i], 0.12); this.vel[k] *= 0.2; this.vel[k + 2] *= 0.2; this.vel[k + 1] = 0; }
      data[i * 2] = Math.max(0, this.life[i] / this.maxLife[i]);
      data[i * 2 + 1] = this.size[i];
    }
    this.points.visible = any;
    if (any) { this.posAttr.needsUpdate = true; this.dataAttr.needsUpdate = true; }
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunRad.value.copy(sunRad);
    this.uniforms.uSkyTint.value.copy(skyTint);
    this.uniforms.uPixelRatio.value = pixelRatio;
  }
}
