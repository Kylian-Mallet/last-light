import * as THREE from 'three';

// Aerial perspective that matches the sky: distant ice and water fade to the colour of
// the horizon in their own direction (warm toward the sun, violet away from it) instead
// of one flat fog colour. The horizon colours come from a tiny cube render of the sky.

const SKY_FOG = { tSkyHorizon: { value: null } };

const FOG_FRAG = /* glsl */`
  #ifdef USE_FOG
    float skyFogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #ifdef SKY_FOG_SCALE
      skyFogFactor *= SKY_FOG_SCALE;
    #endif
    vec3 skyFogDir = normalize(vFogDir);
    vec3 skyFogColor = textureCube(tSkyHorizon, normalize(vec3(skyFogDir.x, 0.05, skyFogDir.z))).rgb;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, skyFogColor, skyFogFactor);
  #endif
`;

function patchSource(o) {
  o.vertexShader = o.vertexShader
    .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vFogDir;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;');
  o.fragmentShader = o.fragmentShader
    .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nvarying vec3 vFogDir;\nuniform samplerCube tSkyHorizon;')
    .replace('#include <fog_fragment>', FOG_FRAG);
}

export function applySkyFog(material) {
  if (material.isShaderMaterial && !material.isRawShaderMaterial && material.vertexShader.includes('fog_vertex')) {
    patchSource(material);
    material.uniforms.tSkyHorizon = SKY_FOG.tSkyHorizon;
    material.needsUpdate = true;
    return material;
  }
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.tSkyHorizon = SKY_FOG.tSkyHorizon;
    patchSource(shader);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|skyfog';
  material.needsUpdate = true;
  return material;
}

export class HorizonProbe {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.camera = new THREE.CubeCamera(0.1, 500, this.rt);
    SKY_FOG.tSkyHorizon.value = this.rt.texture;
  }
  /** skyScene: a scene holding only the sky dome; sunDisc: its showSunDisc uniform. */
  update(skyScene, sunDisc) {
    const prev = sunDisc.value;
    sunDisc.value = 0; // the disc would burn a hot texel into the fog
    this.camera.update(this.renderer, skyScene);
    sunDisc.value = prev;
  }
}
