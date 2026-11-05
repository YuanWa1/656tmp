#version 300 es
precision highp float;
precision highp int;

// Environment-map reflections on a normal-mapped image.
//
// No geometry: three spheres exist only as a view-space normal map plus a
// per-sphere coverage map (baked by scripts/bake_normal_map.py). The rest is
// direction math:
//   1. per-pixel view ray from the same fixed camera the maps were baked with
//   2. decoded normal -> reflection direction (and the normal itself, for
//      diffuse lighting)
//   3. direction -> equirectangular HDR lookup
// Moving the mouse rotates the environment, exercising steps 2-3 under a
// changing view while the normal map stays fixed.
//
// Materials, by sphere (objects.png channels):
//   R  big left     white glazed sphere: diffuse + reflection, u_roughness
//   G  right        polished silver mirror
//   B  small top    polished gold mirror

in vec2 uv;

uniform vec2 u_resolution;
uniform sampler2D u_normalMap;
uniform sampler2D u_objects;
uniform sampler2D u_env;          // radiance, equirectangular, mipmapped; row 0 = up
uniform sampler2D u_irradiance;   // cosine-convolved env / PI, same layout
uniform float u_envWidth;         // radiance texture width in texels
uniform float u_envMaxLod;
uniform mat3 u_envRotation;       // world -> environment rotation
uniform float u_exposure;
uniform float u_roughness;        // rough sphere only, 0 (glossy) .. 1 (matte)
uniform int u_showNormals;

out vec4 outColor;

const float PI = 3.14159265359;
const vec3 PLASTIC_ALBEDO = vec3(0.82, 0.80, 0.78);
const vec3 SILVER_F0 = vec3(0.97, 0.96, 0.92);
const vec3 GOLD_F0 = vec3(1.00, 0.78, 0.34);

// ---------------------------------------------------------------------------
// Camera: must match makeCameraRay() in path_trace.frag with the mouse
// centered, since that is how the normal map was baked.

const float CAMERA_PITCH = 0.24;   // mix(0.1, 0.38, 0.5)
const float FOCAL = 1.55;

mat3 viewToWorld() {
  vec3 offset = vec3(0.0, sin(CAMERA_PITCH) * 0.9, cos(CAMERA_PITCH));
  vec3 f = normalize(-offset);                       // camera forward
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
  vec3 u = cross(r, f);
  // View space: +X right, +Y up, +Z toward the viewer (= -forward).
  return mat3(r, u, -f);
}

vec3 viewRay(vec2 p) {
  vec2 s = p * 2.0 - 1.0;
  s.x *= u_resolution.x / max(u_resolution.y, 1.0);
  return normalize(vec3(s, -FOCAL));
}

// ---------------------------------------------------------------------------
// Normal decoding

vec3 decodeNormal(vec2 p) {
  vec3 n = texture(u_normalMap, p).rgb * 2.0 - 1.0;
  float len = length(n);
  // Filtering shortens the vector; renormalize. Degenerate texels face the viewer.
  return len > 1e-4 ? n / len : vec3(0.0, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Equirectangular lookups

vec2 directionToEquirect(vec3 d) {
  float u = atan(d.x, -d.z) * (0.5 / PI) + 0.5;
  float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

// Radiance along a world direction, blurred to at least minLod.
//
// u wraps from 1 back to 0 behind the viewer. Implicit derivatives see that
// jump as a huge gradient and pick the smallest mip, drawing a seam line. Take
// derivatives of a second parameterization whose wrap is on the opposite side,
// keep whichever is smaller, and pick the mip level from those.
vec3 sampleEnv(vec3 dirWorld, float minLod) {
  vec3 d = u_envRotation * dirWorld;
  vec2 uvA = directionToEquirect(d);
  vec2 uvB = vec2(fract(uvA.x + 0.5) - 0.5, uvA.y);
  vec2 dxA = dFdx(uvA), dyA = dFdy(uvA);
  vec2 dxB = dFdx(uvB), dyB = dFdy(uvB);
  vec2 dx = vec2(abs(dxA.x) < abs(dxB.x) ? dxA.x : dxB.x, dxA.y);
  vec2 dy = vec2(abs(dyA.x) < abs(dyB.x) ? dyA.x : dyB.x, dyA.y);
  vec2 texels = vec2(u_envWidth, u_envWidth * 0.5);
  float footprint = max(dot(dx * texels, dx * texels), dot(dy * texels, dy * texels));
  float lod = max(0.5 * log2(max(footprint, 1e-8)), minLod);
  return textureLod(u_env, uvA, lod).rgb;
}

vec3 sampleIrradiance(vec3 normalWorld) {
  // Tiny, smooth texture: a fixed level is enough, and no seam issue arises.
  return textureLod(u_irradiance, directionToEquirect(u_envRotation * normalWorld), 0.0).rgb;
}

// ---------------------------------------------------------------------------
// Materials

vec3 polishedMetal(vec3 f0, float cosV, vec3 reflection) {
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - cosV, 5.0);
  return fresnel * reflection;
}

// Lambert diffuse lit by the irradiance map, plus a glaze whose reflection
// blurs with roughness. Mip-level blur is a cheap stand-in for a prefiltered
// GGX map. Artistic choice: the glaze's base reflectance also fades with
// roughness (0.3 -> 0.02, a real glaze is ~0.04) so the slider reads clearly,
// from a sharp reflection over white to a purely diffuse matte sphere. Rough
// surfaces also lose the grazing Fresnel boost (Lagarde's approximation).
vec3 roughPlastic(vec3 normalWorld, vec3 reflectWorld, float cosV) {
  float roughness = clamp(u_roughness, 0.0, 1.0);
  float lod = roughness * (u_envMaxLod - 1.0);
  vec3 glossy = sampleEnv(reflectWorld, lod);
  vec3 f0 = vec3(mix(0.3, 0.02, roughness));
  vec3 fresnel = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - cosV, 5.0);
  vec3 diffuse = PLASTIC_ALBEDO * sampleIrradiance(normalWorld);
  return (1.0 - fresnel) * diffuse + fresnel * glossy;
}

vec3 acesFilm(vec3 x) {
  // Narkowicz's ACES fit: keeps HDR highlights from clipping harshly.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 p = uv;
  vec3 objects = texture(u_objects, p).rgb;      // per-sphere coverage
  float coverage = clamp(objects.r + objects.g + objects.b, 0.0, 1.0);

  if (u_showNormals == 1) {
    outColor = vec4(mix(vec3(0.0), decodeNormal(p) * 0.5 + 0.5, coverage), 1.0);
    return;
  }

  mat3 toWorld = viewToWorld();
  vec3 dView = viewRay(p);
  vec3 nView = decodeNormal(p);
  vec3 rView = reflect(dView, nView);
  float cosV = max(dot(-dView, nView), 0.0);

  vec3 dWorld = toWorld * dView;
  vec3 nWorld = toWorld * nView;
  vec3 rWorld = toWorld * rView;

  // Every lookup runs for every pixel: the mip selection needs derivatives,
  // which are only defined in uniform control flow.
  vec3 background = sampleEnv(dWorld, 0.0);
  vec3 mirror = sampleEnv(rWorld, 0.0);
  vec3 plastic = roughPlastic(nWorld, rWorld, cosV);

  vec3 silver = polishedMetal(SILVER_F0, cosV, mirror);
  vec3 gold = polishedMetal(GOLD_F0, cosV, mirror);

  // Coverage is anti-aliased, so silhouettes blend with the background.
  vec3 color = background * (1.0 - coverage)
             + plastic * objects.r + silver * objects.g + gold * objects.b;
  color *= u_exposure;
  outColor = vec4(pow(acesFilm(color), vec3(1.0 / 2.2)), 1.0);
}
