#version 300 es
precision highp float;
precision highp int;

in vec2 uv;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_cameraZOffset;
uniform vec3 u_cameraOffset;
uniform sampler2D u_previousFrame;
uniform int u_frame;
uniform float u_time;

out vec4 outColor;

const int SAMPLES = 8;
const int MAX_BOUNCES = 18;

const float PI = 3.14159265359;
const float INF = 1e20;
const float EPS = 0.001;
const int MAT_DIFFUSE = 0;
const int MAT_DIELECTRIC = 1;
const float FILM_IOR = 1.333; // Soap solution between air on both sides.
// Nanometers, like the wavelengths below. Spatial variation is static so
// progressive accumulation converges rather than mixing moving film patterns.
const float FILM_THICKNESS_NM = 450.0;
const float FILM_VARIATION_NM = 250.0;
const float FILM_NOISE_SCALE = 1.0;
const int RUSSIAN_ROULETTE_START = 3;
const float RUSSIAN_ROULETTE_SURVIVAL = 0.95;

struct Ray {
  vec3 origin;
  vec3 dir;
};

struct Hit {
  float t;
  vec3 pos;
  vec3 normal;
  vec3 albedo;
  vec3 emission;
  int material;
  float ior;
  vec3 filmPosition;
};

void initHit(out Hit hit) {
  hit.t = INF;
  hit.pos = vec3(0.0);
  hit.normal = vec3(0.0, 1.0, 0.0);
  hit.albedo = vec3(0.0);
  hit.emission = vec3(0.0);
  hit.material = MAT_DIFFUSE;
  hit.ior = 1.0;
  hit.filmPosition = vec3(0.0);
}

bool isCloser(float t, Hit hit) {
  return t > EPS && t < hit.t;
}

void commitHit(
  inout Hit hit,
  float t,
  vec3 pos,
  vec3 normal,
  vec3 albedo,
  vec3 emission
) {
  hit.t = t;
  hit.pos = pos;
  hit.normal = normal;
  hit.albedo = albedo;
  hit.emission = emission;
  hit.material = MAT_DIFFUSE;
  hit.ior = 1.0;
}

// A small integer hash for deterministic per-pixel random seeds.
uint hashUint(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

uint makeSeed(ivec2 pixel, int sampleIndex, int bounceIndex) {
  uint seed = uint(pixel.x) * 1973u;
  seed ^= uint(pixel.y) * 9277u;
  seed ^= uint(sampleIndex + 1) * 26699u;
  seed ^= uint(bounceIndex + 1) * 911u;
  seed ^= uint(u_frame + 1) * 1597334677u;
  return hashUint(seed);
}

float rand(inout uint state) {
  state = state * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  word = (word >> 22u) ^ word;
  return float(word & 0x00ffffffu) * (1.0 / 16777216.0);
}

vec2 rand2(inout uint state) {
  return vec2(rand(state), rand(state));
}

void intersectSphere(
  Ray ray,
  vec3 center,
  float radius,
  vec3 albedo,
  int material,
  float ior,
  inout Hit hit
) {
  vec3 oc = ray.origin - center;
  float b = dot(oc, ray.dir);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) {
    return;
  }

  float sqrtH = sqrt(h);
  float t = -b - sqrtH;
  if (t <= EPS) {
    t = -b + sqrtH;
  }
  if (!isCloser(t, hit)) {
    return;
  }

  vec3 pos = ray.origin + t * ray.dir;
  vec3 normal = normalize(pos - center);
  commitHit(hit, t, pos, normal, albedo, vec3(0.0));
  hit.material = material;
  hit.ior = ior;
  // Object-local coordinates keep the film attached to the spherical shell.
  hit.filmPosition = normal + center * 2.7;
}

void intersectPlaneRect(
  Ray ray,
  vec3 point,
  vec3 normal,
  vec2 boundMin,
  vec2 boundMax,
  int axisU,
  int axisV,
  vec3 albedo,
  vec3 emission,
  inout Hit hit
) {
  float denom = dot(ray.dir, normal);
  if (abs(denom) < 1e-5) {
    return;
  }

  float t = dot(point - ray.origin, normal) / denom;
  if (!isCloser(t, hit)) {
    return;
  }

  vec3 pos = ray.origin + t * ray.dir;
  float u = pos[axisU];
  float v = pos[axisV];
  if (u < boundMin.x || u > boundMax.x || v < boundMin.y || v > boundMax.y) {
    return;
  }

  vec3 faceNormal = denom < 0.0 ? normal : -normal;
  commitHit(hit, t, pos, faceNormal, albedo, emission);
}

bool intersectScene(Ray ray, out Hit hit) {
  initHit(hit);
  // Each sphere is a zero-geometric-thickness soap shell, not a solid glass ball.
  intersectSphere(ray, vec3(-0.95, 0.95, 0.0), 0.95, vec3(1.0), MAT_DIELECTRIC, 1.0, hit);
  intersectSphere(ray, vec3(0.9, 0.66, 0.25), 0.66, vec3(1.0), MAT_DIELECTRIC, 1.0, hit);
  intersectSphere(ray, vec3(0.35, 2.05, -0.65), 0.46, vec3(1.0), MAT_DIELECTRIC, 1.0, hit);

  // Dark studio enclosure with large luminous side and ceiling panels.
  // Black gaps preserve contrast instead of lighting every direction equally.
  vec3 dark = vec3(0.006);
  intersectPlaneRect(ray, vec3(0.0), vec3(0,1,0), vec2(-4), vec2(4), 0,2, dark, vec3(0), hit);
  intersectPlaneRect(ray, vec3(0,5,0), vec3(0,-1,0), vec2(-4), vec2(4), 0,2, dark, vec3(0), hit);
  intersectPlaneRect(ray, vec3(-4,0,0), vec3(1,0,0), vec2(0,-4), vec2(5,4), 1,2, dark, vec3(0), hit);
  intersectPlaneRect(ray, vec3(4,0,0), vec3(-1,0,0), vec2(0,-4), vec2(5,4), 1,2, dark, vec3(0), hit);
  intersectPlaneRect(ray, vec3(0,0,-4), vec3(0,0,1), vec2(-4,0), vec2(4,5), 0,1, dark, vec3(0), hit);
  intersectPlaneRect(ray, vec3(0,0,4), vec3(0,0,-1), vec2(-4,0), vec2(4,5), 0,1, dark, vec3(0), hit);
  // Panels are slightly inside the walls to avoid coincident intersections.
  intersectPlaneRect(ray, vec3(-3.98,0,0), vec3(1,0,0), vec2(1.4,-2.8), vec2(4.8,2.8), 1,2, vec3(0), vec3(7.0), hit);
  intersectPlaneRect(ray, vec3(3.98,0,0), vec3(-1,0,0), vec2(2.0,-2.2), vec2(4.6,1.8), 1,2, vec3(0), vec3(5.0), hit);
  intersectPlaneRect(ray, vec3(0,4.98,0), vec3(0,-1,0), vec2(-3.2,-3.0), vec2(3.2,2.0), 0,2, vec3(0), vec3(6.0), hit);
  return hit.t < INF;
}

vec3 environmentRadiance(vec3 direction) {
  return vec3(0.0); // The studio panels provide all illumination.
}

mat3 tangentBasis(vec3 normal) {
  vec3 helper = abs(normal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  return mat3(tangent, bitangent, normal);
}

vec3 cosineWeightedHemisphere(vec3 normal, inout uint rngState) {
  vec2 r = rand2(rngState);
  float radius = sqrt(r.x);
  float phi = 2.0 * PI * r.y;

  vec3 localDir = vec3(
    radius * cos(phi),
    radius * sin(phi),
    sqrt(max(0.0, 1.0 - r.x))
  );

  return normalize(tangentBasis(normal) * localDir);
}

// Stable lattice gradients depend only on position, never the path RNG or frame.
vec2 filmNoiseGradient(ivec2 cell) {
  uint seed = hashUint(uint(cell.x) * 1973u ^ uint(cell.y) * 9277u);
  float angle = float(seed & 0x00ffffffu) * (2.0 * PI / 16777216.0);
  return vec2(cos(angle), sin(angle));
}

// 2D Perlin gradient noise: quintic interpolation keeps derivatives continuous
// across cell boundaries, avoiding grid seams in the thin-film colors.
float filmPerlinNoise(vec2 p) {
  ivec2 cell = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 fade = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(filmNoiseGradient(cell), f);
  float n10 = dot(filmNoiseGradient(cell + ivec2(1, 0)), f - vec2(1.0, 0.0));
  float n01 = dot(filmNoiseGradient(cell + ivec2(0, 1)), f - vec2(0.0, 1.0));
  float n11 = dot(filmNoiseGradient(cell + ivec2(1, 1)), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, fade.x), mix(n01, n11, fade.x), fade.y);
}

float filmThicknessNm(vec3 position) {
  // Blend three Perlin projections for a continuous volume field: no UV seam
  // or pole singularity. Domain warping produces irregular flowing film bands.
  vec3 p = position * FILM_NOISE_SCALE;
  p += 0.65 * vec3(filmPerlinNoise(p.yz + 7.1),
                   filmPerlinNoise(p.zx + 13.4), filmPerlinNoise(p.xy + 2.6));
  float noise = 0.0;
  float amplitude = 1.0;
  float amplitudeSum = 0.0;
  for (int octave = 0; octave < 5; ++octave) {
    noise += amplitude * (filmPerlinNoise(p.xy) + filmPerlinNoise(p.yz)
                        + filmPerlinNoise(p.zx)) / 3.0;
    amplitudeSum += amplitude;
    p = p.yzx * 2.03 + vec3(17.1, 9.2, 5.7);
    amplitude *= 0.5;
  }
  float pattern = clamp(3.5 * noise / amplitudeSum, -1.0, 1.0);
  return FILM_THICKNESS_NM + FILM_VARIATION_NM * pattern;
}

// Airy reflectance sums all internal reflections of a lossless parallel film.
// Signed amplitude coefficients retain interface phase flips (including the
// p-polarization sign change); squaring them too early loses interference.
vec3 airyReflectance(float r01, float r12, vec3 cosPhase) {
  float product = r01 * r12;
  return (vec3(r01 * r01 + r12 * r12) + 2.0 * product * cosPhase)
       / max(vec3(1.0 + product * product) + 2.0 * product * cosPhase, vec3(1e-7));
}

// Returns approximate RGB power reflectance for the air/soap-film/air
// stack. Three representative wavelengths are a prototype approximation,
// not spectral integration into a color-matching space. IORs are nondispersive.
vec3 thinFilmReflectance(float cosI, float n0, float n2, float thicknessNm) {
  float sin2I = max(0.0, 1.0 - cosI * cosI);
  float sin2Film = (n0 / FILM_IOR) * (n0 / FILM_IOR) * sin2I;
  float sin2Exit = (n0 / n2) * (n0 / n2) * sin2I;
  // FILM_IOR exceeds the surrounding air IOR, so the film has no evanescent
  // propagation here. If the exit medium cannot transmit, all power reflects.
  if (sin2Exit >= 1.0 || cosI <= 1e-6) return vec3(1.0);
  float cosFilm = sqrt(max(0.0, 1.0 - sin2Film));
  float cosExit = sqrt(max(0.0, 1.0 - sin2Exit));
  float rs01 = (n0 * cosI - FILM_IOR * cosFilm) / (n0 * cosI + FILM_IOR * cosFilm);
  float rs12 = (FILM_IOR * cosFilm - n2 * cosExit) / (FILM_IOR * cosFilm + n2 * cosExit);
  float rp01 = (FILM_IOR * cosI - n0 * cosFilm) / (FILM_IOR * cosI + n0 * cosFilm);
  float rp12 = (n2 * cosFilm - FILM_IOR * cosExit) / (n2 * cosFilm + FILM_IOR * cosExit);
  vec3 wavelengthsNm = vec3(650.0, 550.0, 450.0);
  vec3 cosPhase = cos(4.0 * PI * FILM_IOR * thicknessNm * cosFilm / wavelengthsNm);
  return clamp(0.5 * (airyReflectance(rs01, rs12, cosPhase)
                   + airyReflectance(rp01, rp12, cosPhase)), 0.0, 1.0);
}

// Samples a smooth coated interface and returns its Monte Carlo RGB weight.
// The nanometer film is evaluated optically, without extra geometric surfaces.
// Air exists on both sides (hit.ior = 1), so transmitted rays continue straight.
// Crossing the back of a sphere samples its second, spatially distinct film patch.
vec3 sampleDielectric(Hit hit, Ray ray, inout uint rngState, out vec3 weight) {
  bool frontFace = dot(ray.dir, hit.normal) < 0.0;
  vec3 normal = frontFace ? hit.normal : -hit.normal;
  float etaI = frontFace ? 1.0 : hit.ior;
  float etaT = frontFace ? hit.ior : 1.0;
  float eta = etaI / etaT;
  float cosTheta = clamp(dot(-ray.dir, normal), 0.0, 1.0);
  float sin2Theta = max(0.0, 1.0 - cosTheta * cosTheta);
  if (eta * eta * sin2Theta >= 1.0) {
    weight = vec3(1.0);
    return reflect(ray.dir, normal);
  }

  vec3 reflection = thinFilmReflectance(cosTheta, etaI, etaT, filmThicknessNm(hit.filmPosition));
  float probability = dot(reflection, vec3(1.0 / 3.0));
  if (probability >= 1.0) {
    weight = vec3(1.0);
    return reflect(ray.dir, normal);
  }
  if (probability > 0.0 && rand(rngState) < probability) {
    // A single direction is shared by RGB; divide by the scalar branch PDF.
    weight = reflection / probability;
    return reflect(ray.dir, normal);
  }

  // Lossless transmission is 1-R. eta^2 converts radiance across media;
  // entry/exit factors cancel for a path that returns to the original medium.
  weight = (vec3(1.0) - reflection) * (eta * eta) / (1.0 - probability);
  return refract(ray.dir, normal, eta);
}

bool surviveRussianRoulette(int bounce, inout vec3 throughput, inout uint rngState) {
  if (bounce < RUSSIAN_ROULETTE_START) {
    return true;
  }

  if (rand(rngState) > RUSSIAN_ROULETTE_SURVIVAL) {
    return false;
  }

  throughput /= RUSSIAN_ROULETTE_SURVIVAL;
  return true;
}

// Constructs an orthonormal basis matrix given a forward and up vector.
mat3 cameraBasis(vec3 forward, vec3 up) {
  vec3 f = normalize(forward);
  vec3 r = normalize(cross(f, up));
  vec3 u = cross(r, f);
  return mat3(r, u, f);
}

Ray makeCameraRay(vec2 sampleUv) {
  vec2 screen = sampleUv * 2.0 - 1.0;
  screen.x *= u_resolution.x / max(u_resolution.y, 1.0);

  float yaw = mix(-0.5, 0.5, u_mouse.x);
  // A low studio view shows the curved shells while keeping the floor visible.
  float pitch = mix(0.1, 0.38, u_mouse.y);

  vec3 target = vec3(0.0, 0.85, -0.2 + u_cameraZOffset) + u_cameraOffset;
  float camDist = 3.7;
  vec3 camPos = target + vec3(
    sin(yaw) * cos(pitch),
    sin(pitch) * 0.9,
    cos(yaw) * cos(pitch)
  ) * camDist;

  mat3 cam = cameraBasis(target - camPos, vec3(0.0, 1.0, 0.0));

  Ray ray;
  ray.origin = camPos;
  ray.dir = normalize(cam * vec3(screen, 1.55));
  return ray;
}

vec3 tracePath(Ray ray, ivec2 pixel, int sampleIndex, inout uint rngState) {
  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);

  for (int bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
    rngState ^= makeSeed(pixel, sampleIndex, bounce);

    Hit hit;
    if (!intersectScene(ray, hit)) {
      // Every escaping path samples the environment, including diffuse bounces.
      // There is no separate light sampler, so this does not double-count it.
      radiance += throughput * environmentRadiance(ray.dir);
      break;
    }

    // Panel hits are the only light source; no separate direct-light sampler
    // is used, so adding emission here does not double-count lighting.
    if (max(hit.emission.r, max(hit.emission.g, hit.emission.b)) > 0.0) {
      radiance += throughput * hit.emission;
      break;
    }

    if (hit.material == MAT_DIELECTRIC) {
      if (!surviveRussianRoulette(bounce, throughput, rngState)) {
        break;
      }

      vec3 weight;
      vec3 nextDir = sampleDielectric(hit, ray, rngState, weight);
      throughput *= weight;
      vec3 offsetNormal = dot(nextDir, hit.normal) > 0.0 ? hit.normal : -hit.normal;
      ray.origin = hit.pos + offsetNormal * EPS;
      ray.dir = normalize(nextDir);
      continue;
    }

    if (!surviveRussianRoulette(bounce, throughput, rngState)) {
      break;
    }

    vec3 nextDir = cosineWeightedHemisphere(hit.normal, rngState);
    throughput *= hit.albedo;

    ray.origin = hit.pos + hit.normal * EPS;
    ray.dir = nextDir;
  }

  return radiance;
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 pixelBase = floor(gl_FragCoord.xy);
  vec3 accumulatedRadiance = vec3(0.0);

  for (int sampleIndex = 0; sampleIndex < SAMPLES; ++sampleIndex) {
    uint rngState = makeSeed(pixel, sampleIndex, 0);

    vec2 jitter = rand2(rngState);
    vec2 sampleUv = (pixelBase + jitter) / max(u_resolution, vec2(1.0));

    Ray ray = makeCameraRay(sampleUv);
    accumulatedRadiance += tracePath(ray, pixel, sampleIndex, rngState);
  }

  vec3 color = accumulatedRadiance / float(SAMPLES);

  if (u_frame > 0) {
    vec3 previousColor = texelFetch(u_previousFrame, pixel, 0).rgb;
    float frameWeight = float(u_frame);
    color = (previousColor * frameWeight + color) / (frameWeight + 1.0);
  }

  outColor = vec4(color, 1.0);
}
