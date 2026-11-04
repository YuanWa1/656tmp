#version 300 es
precision highp float;
precision highp int;

// Normal-map soap bubbles: a fixed view lit by a movable point light.
//
// There is no geometry here. Every pixel's surface comes from images baked
// from the path tracer's scene (scripts/bake_normal_map.py):
//   u_normalMap   front-most normal, bubbles included
//   u_normalBack  normal of the surface seen through a bubble
//   u_albedo      albedo of that surface (sRGB texture -> linear on sampling)
//   u_mask        bubble coverage
// Normals are view space: +X right, +Y up, +Z toward the viewer.

in vec2 uv;

uniform vec2 u_resolution;
uniform sampler2D u_normalMap;
uniform sampler2D u_normalBack;
uniform sampler2D u_albedo;
uniform sampler2D u_mask;

uniform vec2 u_light;           // light position in uv space (0..1)
uniform float u_lightHeight;    // light distance above the image plane
uniform float u_colorShift;     // artistic: how far the colors sweep with the light
uniform int u_showNormals;      // 1 shows the decoded normals instead

out vec4 outColor;

const float PI = 3.14159265359;
const float FILM_IOR = 1.333;
const float FILM_THICKNESS_NM = 420.0;
const float FILM_VARIATION_NM = 220.0;
const vec3 LIGHT_COLOR = vec3(1.0, 0.97, 0.92);
const vec3 V = vec3(0.0, 0.0, 1.0); // orthographic view of the baked image

const float LIGHT_INTENSITY = 4.0;
const float AMBIENT = 0.06;
const float SPECULAR_STRENGTH = 1.5;
const float SHININESS = 160.0;
const float ENV_REFLECTION = 1.4;   // brightness of the environment the film reflects
const float VIVIDNESS = 1.0;        // artistic saturation/brightness of the film

// ---------------------------------------------------------------------------
// Normal decoding

vec3 decodeNormal(sampler2D map, vec2 p) {
  vec3 n = texture(map, p).rgb * 2.0 - 1.0;
  // Filtering between texels shortens the vector; renormalize. A degenerate
  // texel (e.g. black) falls back to facing the viewer instead of NaN.
  float len = length(n);
  return len > 1e-4 ? n / len : V;
}

// ---------------------------------------------------------------------------
// Thin-film interference (same physics as path_trace.frag)

vec3 airyReflectance(float r01, float r12, vec3 cosPhase) {
  float product = r01 * r12;
  return (vec3(r01 * r01 + r12 * r12) + 2.0 * product * cosPhase)
       / max(vec3(1.0 + product * product) + 2.0 * product * cosPhase, vec3(1e-7));
}

// RGB power reflectance of an air / soap film / air stack, averaged over
// s and p polarization, at three representative wavelengths.
vec3 thinFilmReflectance(float cosI, float thicknessNm) {
  cosI = clamp(cosI, 1e-4, 1.0);
  float sin2I = 1.0 - cosI * cosI;
  float cosFilm = sqrt(max(0.0, 1.0 - sin2I / (FILM_IOR * FILM_IOR)));
  float rs01 = (cosI - FILM_IOR * cosFilm) / (cosI + FILM_IOR * cosFilm);
  float rp01 = (FILM_IOR * cosI - cosFilm) / (FILM_IOR * cosI + cosFilm);
  // Air on both sides: the second interface mirrors the first.
  float rs12 = -rs01;
  float rp12 = -rp01;
  vec3 wavelengthsNm = vec3(650.0, 550.0, 450.0);
  vec3 cosPhase = cos(4.0 * PI * FILM_IOR * thicknessNm * cosFilm / wavelengthsNm);
  return clamp(0.5 * (airyReflectance(rs01, rs12, cosPhase)
                   + airyReflectance(rp01, rp12, cosPhase)), 0.0, 1.0);
}

// Static 2D gradient noise for film thickness. It depends only on position,
// so the pattern never shimmers as the light moves.
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

float filmThicknessNm(vec2 p, vec3 n) {
  // Offsetting by the normal makes the bands bend around each bubble's
  // curvature instead of looking like a flat screen-space overlay.
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
  // Gravity drains the film: thinner near the top of a bubble, which also
  // lays the colors out in roughly horizontal, swirling bands.
  float drainage = -170.0 * n.y;
  return max(FILM_THICKNESS_NM + FILM_VARIATION_NM * pattern + drainage, 60.0);
}

// ---------------------------------------------------------------------------
// Lighting

struct LightSample {
  vec3 L;         // unit direction from the surface point to the light
  vec3 radiance;  // incoming radiance after distance falloff
};

LightSample sampleLight(vec2 p) {
  // Work in aspect-corrected units so falloff is round on any canvas shape.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec3 toLight = vec3((u_light - p) * vec2(aspect, 1.0), u_lightHeight);
  float dist2 = dot(toLight, toLight);
  LightSample s;
  s.L = toLight * inversesqrt(dist2);
  s.radiance = LIGHT_COLOR * LIGHT_INTENSITY / (1.0 + 2.5 * dist2);
  return s;
}

// Studio environment seen in bubble reflections, so the film shows color
// even away from the highlight: a bright overhead softbox fading to a dark
// floor. Fixed in view space, so it never moves.
vec3 environment(vec3 dir) {
  float sky = smoothstep(-0.15, 0.85, dir.y);
  vec3 env = mix(vec3(0.02, 0.02, 0.025), vec3(0.85, 0.88, 0.95), sky);
  return env * ENV_REFLECTION;
}

// Diffuse room surface: Lambert plus a faint Schlick-weighted Blinn-Phong
// sheen, so diffuse and specular are both visible away from the bubbles.
vec3 shadeSurface(vec2 p) {
  vec3 n = decodeNormal(u_normalBack, p);
  vec3 albedo = texture(u_albedo, p).rgb;
  LightSample light = sampleLight(p);

  float nDotL = max(dot(n, light.L), 0.0);
  vec3 h = normalize(light.L + V);
  float nDotH = max(dot(n, h), 0.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(h, V), 0.0), 5.0);
  // Fade the highlight in at the terminator so it never pops on or off.
  float terminator = smoothstep(0.0, 0.15, nDotL);
  float shininess = SHININESS * 0.25;
  float normalization = (shininess + 8.0) / (8.0 * PI);

  vec3 diffuse = albedo * light.radiance * nDotL;
  vec3 specular = fresnel * normalization * pow(nDotH, shininess)
                * SPECULAR_STRENGTH * 0.5 * light.radiance * terminator;
  return albedo * AMBIENT + diffuse + specular;
}

// Artistic grading of the physical film reflectance: push saturation and
// brightness so the interference colors read clearly over a bright room.
vec3 stylizeFilm(vec3 reflectance) {
  float luma = dot(reflectance, vec3(0.2126, 0.7152, 0.0722));
  vec3 saturated = max(mix(vec3(luma), reflectance, 1.0 + 1.5 * VIVIDNESS), 0.0);
  return saturated * (1.0 + 2.5 * VIVIDNESS);
}

// Soap film over the background: transmitted background, iridescent
// reflection of the environment, and an iridescent highlight from the light.
vec3 shadeBubble(vec2 p, vec3 background) {
  vec3 n = decodeNormal(u_normalMap, p);
  LightSample light = sampleLight(p);

  // Artistic, not physical: slide the film thickness with the angle at which
  // the light hits each point. Moving the light sweeps the color bands across
  // the whole bubble instead of only nudging the hue of the highlight.
  float facing = max(dot(n, light.L), 0.0);
  float thickness = filmThicknessNm(p, n) + u_colorShift * 420.0 * (0.55 - facing);

  float nDotV = max(dot(n, V), 0.0);
  vec3 h = normalize(light.L + V);
  float nDotH = max(dot(n, h), 0.0);
  vec3 filmView = thinFilmReflectance(nDotV, thickness);
  vec3 filmLight = thinFilmReflectance(max(dot(h, light.L), 0.0), thickness);

  // Mirror reflection of the fixed studio environment.
  vec3 envReflection = stylizeFilm(filmView) * environment(reflect(-V, n));

  // Broad glossy sheen plus a sharp highlight, tinted by the film.
  float terminator = smoothstep(0.0, 0.15, facing);
  float sheen = 0.8 * pow(nDotH, 48.0);
  float normalization = (SHININESS + 8.0) / (8.0 * PI);
  float sharp = normalization * pow(nDotH, SHININESS) * SPECULAR_STRENGTH;
  vec3 lightReflection = stylizeFilm(filmLight) * (sheen + sharp) * light.radiance * terminator;

  // Transmission uses the physical reflectance so the bubble stays clear.
  return background * (1.0 - filmView) + envReflection + lightReflection;
}

vec3 toneMap(vec3 c) {
  c = c / (c + vec3(1.0));          // Reinhard, as in display.frag
  return pow(c, vec3(1.0 / 2.2));
}

void main() {
  vec2 p = uv;

  if (u_showNormals == 1) {
    // Decoded, renormalized normals re-encoded for display.
    outColor = vec4(decodeNormal(u_normalMap, p) * 0.5 + 0.5, 1.0);
    return;
  }

  vec3 color = shadeSurface(p);
  float bubble = texture(u_mask, p).r;
  if (bubble > 0.0) {
    // Mask is anti-aliased; blend at the silhouette.
    color = mix(color, shadeBubble(p, color), bubble);
  }

  // Small glow marking where the light is.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  float d = length((p - u_light) * vec2(aspect, 1.0));
  outColor = vec4(toneMap(color) + vec3(1.0, 0.95, 0.85) * exp(-d * d * 9000.0), 1.0);
}
