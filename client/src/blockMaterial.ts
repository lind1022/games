import * as THREE from 'three';

/**
 * Lighting constants shared between this shader's uniforms and main.ts's
 * actual THREE.AmbientLight/DirectionalLight — kept in one place so the
 * hand-rolled diffuse lighting below can't silently drift out of sync with
 * the real scene lights. main.ts uses LIGHT_COLOR/the two intensities/
 * SUN_POSITION directly when constructing its THREE.Light objects.
 */
export const LIGHT_COLOR = 0xffffff;
export const AMBIENT_INTENSITY = 0.6;
export const SUN_INTENSITY = 0.8;
export const SUN_POSITION = new THREE.Vector3(50, 100, 25);

const VERTEX_SHADER = /* glsl */ `
precision mediump float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

in vec3 position;
in vec3 normal;
in vec2 uv;
in float layer;

out vec2 vUv;
out float vLayer;
out vec3 vNormal;

void main() {
  vUv = uv;
  vLayer = layer;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
precision mediump sampler2DArray;

uniform sampler2DArray map;
uniform vec3 ambientColor;
uniform vec3 sunColor;
uniform vec3 sunDirection;

in vec2 vUv;
in float vLayer;
in vec3 vNormal;

out vec4 fragColor;

void main() {
  // Tiles the texture within each block unit rather than stretching one
  // copy across a greedy-merged multi-block quad (mesh.ts's uvs span
  // [0,w]x[0,h], not [0,1]) — see textures.ts for why a texture array
  // (independent layers) makes this safe against atlas bleeding.
  vec2 tiled = fract(vUv);
  float layerIndex = floor(vLayer + 0.5);
  vec4 texColor = texture(map, vec3(tiled, layerIndex));

  float diffuse = max(dot(normalize(vNormal), sunDirection), 0.0);
  vec3 lit = texColor.rgb * (ambientColor + sunColor * diffuse);
  fragColor = vec4(lit, texColor.a);
}
`;

/**
 * Hand-rolled RawShaderMaterial (not ShaderMaterial — declares every
 * attribute/uniform explicitly, nothing auto-injected) replicating
 * MeshLambertMaterial's ambient+diffuse look closely enough for this
 * project's flat, unshadowed lighting, but sampling a per-block-type
 * texture-array layer instead of a flat vertex color.
 */
export function createBlockMaterial(map: THREE.DataArrayTexture): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      map: { value: map },
      ambientColor: { value: new THREE.Color(LIGHT_COLOR).multiplyScalar(AMBIENT_INTENSITY) },
      sunColor: { value: new THREE.Color(LIGHT_COLOR).multiplyScalar(SUN_INTENSITY) },
      sunDirection: { value: SUN_POSITION.clone().normalize() },
    },
  });
}
