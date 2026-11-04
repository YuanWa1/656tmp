#version 300 es
precision highp float;
precision highp int;

// Environment-map reflections on a normal-mapped image.
//
// No geometry: the bubbles exist only as a view-space normal map plus a
// coverage mask (baked by scripts/bake_normal_map.py from the path tracer's
// scene). Everything else is direction math:
//   1. per-pixel view ray from the same fixed camera the maps were baked with
//   2. decoded normal -> reflection direction
//   3. direction -> equirectangular HDR lookup
// Moving the mouse rotates the environment, which exercises steps 2-3 under
// a changing "view" while the normal map stays fixed.

in vec2 uv;

uniform vec2 u_resolution;
uniform sampler2D u_normalMap;
uniform sampler2D u_mask;
uniform sampler2D u_env;          // equirectangular HDR, row 0 = straight up
uniform mat3 u_envRotation;       // world -> environment rotation
uniform float u_exposure;
uniform int u_material;           // 0 soap film, 1 mirror
uniform int u_showNormals;

out vec4 outColor;

const float PI = 3.14159265359;
const float FILM_IOR = 1.333;
const float FILM_THICKNESS_NM = 420.0;
const float FILM_VARIATION_NM = 220.0;
const float VIVIDNESS = 1.0;

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

// View ray through this pixel, in view space.
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
// Equirectangular lookup

vec2 directionToEquirect(vec3 d) {
  float u = atan(d.x, -d.z) * (0.5 / PI) + 0.5;
  float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

// u wraps from 1 back to 0 behind the viewer. Implicit derivatives see that
// jump as a huge gradient and pick the smallest mip, drawing a seam line. Take
// derivatives of a second parameterization whose wrap is on the opposite side
// and keep whichever is smaller, then sample with explicit gradients.
vec3 sampleEnv(vec3 dirWorld) {
  vec3 d = u_envRotation * dirWorld;
  vec2 uvA = directionToEquirect(d);
  vec2 uvB = vec2(fract(uvA.x + 0.5) - 0.5, uvA.y);
  vec2 dxA = dFdx(uvA), dyA = dFdy(uvA);
  vec2 dxB = dFdx(uvB), dyB = dFdy(uvB);
  vec2 dx = vec2(abs(dxA.x) < abs(dxB.x) ? dxA.x : dxB.x, dxA.y);
  vec2 dy = vec2(abs(dyA.x) < abs(dyB.x) ? dyA.x : dyB.x, dyA.y);
  return textureGrad(u_env, uvA, dx, dy).rgb;
}

// ---------------------------------------------------------------------------
// Thin film (same model as normal_map.frag)

vec3 airyReflectance(float r01, float r12, vec3 cosPhase) {
  float product = r01 * r12;
  return (vec3(r01 * r01 + r12 * r12) + 2.0 * product * cosPhase)
       / max(vec3(1.0 + product * product) + 2.0 * product * cosPhase, vec3(1e-7));
}

vec3 thinFilmReflectance(float cosI, float thicknessNm) {
  cosI = clamp(cosI, 1e-4, 1.0);
  float sin2I = 1.0 - cosI * cosI;
  float cosFilm = sqrt(max(0.0, 1.0 - sin2I / (FILM_IOR * FILM_IOR)));
  float rs01 = (cosI - FILM_IOR * cosFilm) / (cosI + FILM_IOR * cosFilm);
  float rp01 = (FILM_IOR * cosI - cosFilm) / (FILM_IOR * cosI + cosFilm);
  vec3 wavelengthsNm = vec3(650.0, 550.0, 450.0);
  vec3 cosPhase = cos(4.0 * PI * FILM_IOR * thicknessNm * cosFilm / wavelengthsNm);
  return clamp(0.5 * (airyReflectance(rs01, -rs01, cosPhase)
                   + airyReflectance(rp01, -rp01, cosPhase)), 0.0, 1.0);
}

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gradientNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash2(i), f);
  float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// Static thickness field; offset by the normal so bands follow the curvature
// and differ between the front and back film. Thinner toward the top.
float filmThicknessNm(vec2 p, vec3 n) {
  vec2 q = p * 1.8 + n.xy * 0.8;
  q += 0.9 * vec2(gradientNoise(q + 7.1), gradientNoise(q + 13.4));
  float noise = 0.0;
  float amplitude = 1.0;
  float amplitudeSum = 0.0;
  for (int octave = 0; octave < 3; ++octave) {
    noise += amplitude * gradientNoise(q);
    amplitudeSum += amplitude;
    q = q * 2.03 + vec2(17.1, 9.2);
    amplitude *= 0.5;
  }
  float pattern = clamp(1.8 * noise / amplitudeSum, -1.0, 1.0);
  return max(FILM_THICKNESS_NM + FILM_VARIATION_NM * pattern - 170.0 * n.y, 60.0);
}

vec3 stylizeFilm(vec3 reflectance) {
  float luma = dot(reflectance, vec3(0.2126, 0.7152, 0.0722));
  vec3 saturated = max(mix(vec3(luma), reflectance, 1.0 + 1.5 * VIVIDNESS), 0.0);
  return min(saturated * (1.0 + 2.5 * VIVIDNESS), vec3(1.0));
}

// ---------------------------------------------------------------------------

vec3 acesFilm(vec3 x) {
  // Narkowicz's ACES fit: keeps HDR highlights from clipping harshly.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 p = uv;
  float bubble = texture(u_mask, p).r;

  if (u_showNormals == 1) {
    vec3 nShow = decodeNormal(p) * 0.5 + 0.5;
    outColor = vec4(mix(vec3(0.0), nShow, bubble), 1.0);
    return;
  }

  mat3 toWorld = viewToWorld();
  vec3 dView = viewRay(p);
  vec3 nView = decodeNormal(p);

  // Directions, all in view space.
  vec3 rFront = reflect(dView, nView);
  // A sphere's exit point mirrors its entry point across the plane through
  // the center perpendicular to the ray, so its outward normal is the front
  // normal with the along-ray component flipped. The film has air on both
  // sides, so the ray reaches it undeflected; seen from inside, it reflects
  // about the inward normal.
  vec3 nBack = nView - 2.0 * dot(nView, dView) * dView;
  vec3 rBack = reflect(dView, -nBack);

  // Every lookup runs for every pixel: textureGrad needs derivatives, which
  // are only defined in uniform control flow.
  vec3 envStraight = sampleEnv(toWorld * dView);
  vec3 envFront = sampleEnv(toWorld * rFront);
  vec3 envBack = sampleEnv(toWorld * rBack);

  vec3 surface;
  if (u_material == 1) {
    // Polished silver: Schlick Fresnel toward white at grazing angles.
    vec3 f0 = vec3(0.95, 0.93, 0.88);
    float cosI = max(dot(-dView, nView), 0.0);
    vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - cosI, 5.0);
    surface = envFront * fresnel;
  } else {
    float cosFront = max(dot(-dView, nView), 0.0);
    float cosBack = max(dot(dView, nBack), 0.0);
    vec3 rf = thinFilmReflectance(cosFront, filmThicknessNm(p, nView));
    vec3 rb = thinFilmReflectance(cosBack, filmThicknessNm(p, nBack));
    // Front reflection + back reflection seen through the front film +
    // the environment transmitted through both films.
    surface = stylizeFilm(rf) * envFront
            + (1.0 - rf) * stylizeFilm(rb) * envBack * 0.8
            + (1.0 - rf) * (1.0 - rb) * envStraight;
  }

  vec3 color = mix(envStraight, surface, bubble) * u_exposure;
  outColor = vec4(pow(acesFilm(color), vec3(1.0 / 2.2)), 1.0);
}
