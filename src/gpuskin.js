import * as THREE from 'three';

// Skin once, draw many times.
// The chick's 210k vertices are skinned in a single GPU pass (one point per vertex) into
// float textures (position, normal). Every consumer — the body, its shadow, the water
// reflection and all fur shells — then reads the skinned vertex with two texelFetch calls
// instead of re-running linear blend skinning (16 bone-texture fetches + 4 mat4 products).

const SKIN_VERT = /* glsl */`
  precision highp float;
  precision highp int;
  uniform highp sampler2D boneTexture;
  uniform mat4 bindMatrix;
  uniform mat4 bindMatrixInverse;
  uniform ivec2 uSize;
  in vec3 position;
  in vec3 normal;
  in vec3 furNormal;
  in vec4 skinIndex;
  in vec4 skinWeight;
  flat out vec3 vPos;
  flat out vec3 vNor;
  flat out vec3 vFurN;
  mat4 getBoneMatrix(const in float i) {
    int size = textureSize(boneTexture, 0).x;
    int j = int(i) * 4;
    int x = j % size;
    int y = j / size;
    vec4 v1 = texelFetch(boneTexture, ivec2(x, y), 0);
    vec4 v2 = texelFetch(boneTexture, ivec2(x + 1, y), 0);
    vec4 v3 = texelFetch(boneTexture, ivec2(x + 2, y), 0);
    vec4 v4 = texelFetch(boneTexture, ivec2(x + 3, y), 0);
    return mat4(v1, v2, v3, v4);
  }
  void main() {
    mat4 bX = getBoneMatrix(skinIndex.x);
    mat4 bY = getBoneMatrix(skinIndex.y);
    mat4 bZ = getBoneMatrix(skinIndex.z);
    mat4 bW = getBoneMatrix(skinIndex.w);
    vec4 sv = bindMatrix * vec4(position, 1.0);
    vec4 skinned = bX * sv * skinWeight.x + bY * sv * skinWeight.y + bZ * sv * skinWeight.z + bW * sv * skinWeight.w;
    vPos = (bindMatrixInverse * skinned).xyz;
    mat4 skinMatrix = bindMatrixInverse * (skinWeight.x * bX + skinWeight.y * bY + skinWeight.z * bZ + skinWeight.w * bW) * bindMatrix;
    vNor = normalize((skinMatrix * vec4(normal, 0.0)).xyz);
    vFurN = normalize((skinMatrix * vec4(furNormal, 0.0)).xyz);
    ivec2 c = ivec2(gl_VertexID % uSize.x, gl_VertexID / uSize.x);
    gl_Position = vec4((vec2(c) + 0.5) / vec2(uSize) * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = 1.0;
  }
`;

const SKIN_FRAG = /* glsl */`
  precision highp float;
  flat in vec3 vPos;
  flat in vec3 vNor;
  flat in vec3 vFurN;
  layout(location = 0) out highp vec4 gPos;
  layout(location = 1) out highp vec4 gNor;
  layout(location = 2) out highp vec4 gFurN;
  void main() {
    gPos = vec4(vPos, 1.0);
    gNor = vec4(vNor, 0.0);
    gFurN = vec4(vFurN, 0.0);
  }
`;

// Chunk replacements for any material that should read the pre-skinned vertex.
const SKINNED_FETCH_PARS = /* glsl */`
  uniform highp sampler2D tSkinPos;
  uniform highp sampler2D tSkinNor;
  uniform highp sampler2D tSkinFurN;
  uniform int uSkinWidth;
  ivec2 skinCoord() { return ivec2(gl_VertexID % uSkinWidth, gl_VertexID / uSkinWidth); }
`;

export class GpuSkinner {
  constructor(renderer, skinnedMesh) {
    this.renderer = renderer;
    this.mesh = skinnedMesh;
    const geo = skinnedMesh.geometry;
    this.count = geo.attributes.position.count;
    this.width = 1024;
    this.height = Math.ceil(this.count / this.width);
    this.rt = new THREE.WebGLRenderTarget(this.width, this.height, {
      count: 3, // position, normal, smoothed normal for the fur shells
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    const skel = skinnedMesh.skeleton;
    if (!skel.boneTexture) skel.computeBoneTexture();

    const pg = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'skinIndex', 'skinWeight']) pg.setAttribute(k, geo.attributes[k]);
    pg.setAttribute('furNormal', geo.attributes.normal); // replaced by setFurNormal()
    this.pointsGeometry = pg;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        boneTexture: { value: skel.boneTexture },
        bindMatrix: { value: skinnedMesh.bindMatrix },
        bindMatrixInverse: { value: skinnedMesh.bindMatrixInverse },
        uSize: { value: new THREE.Vector2(this.width, this.height) },
      },
      vertexShader: SKIN_VERT,
      fragmentShader: SKIN_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.points = new THREE.Points(pg, this.material);
    this.points.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.points);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // shared uniforms for consumers
    this.uniforms = {
      tSkinPos: { value: this.rt.textures[0] },
      tSkinNor: { value: this.rt.textures[1] },
      tSkinFurN: { value: this.rt.textures[2] },
      uSkinWidth: { value: this.width },
    };
  }

  /** Rest-pose normals the fur shells grow along (smoother than the shading normals). */
  setFurNormal(attr) { this.pointsGeometry.setAttribute('furNormal', attr); }

  /** Call once per frame after the bones have moved. */
  update() {
    const skel = this.mesh.skeleton;
    this.mesh.updateMatrixWorld(true);
    skel.update();
    // ivec2 uniform: three uploads Vector2 as vec2; pass ints via the uniform value
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
  }

  /** Patch a material (standard/physical/depth) to read skinned data instead of attributes. */
  patch(material, afterPatch) {
    const uniforms = this.uniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + SKINNED_FETCH_PARS)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = texelFetch(tSkinNor, skinCoord(), 0).xyz;')
        .replace('#include <begin_vertex>', 'vec3 transformed = texelFetch(tSkinPos, skinCoord(), 0).xyz;');
      afterPatch?.(shader);
    };
    const prevKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|gpuskin';
    material.needsUpdate = true;
    return material;
  }
}
