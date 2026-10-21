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

const int SAMPLES = 2;
const int MAX_BOUNCES = 18;

const float PI = 3.14159265359;
const float INF = 1e20;
const float EPS = 0.001;
const int MAT_DIFFUSE = 0;
const int MAT_DIELECTRIC = 1;
const float WATER_IOR = 1.333;
const float OIL_IOR = 1.46;
// Nanometers, like the wavelengths below. Spatial variation is static so
// progressive accumulation converges rather than mixing moving film patterns.
const float FILM_THICKNESS_NM = 450.0;
const float FILM_VARIATION_NM = 250.0;
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
};

void initHit(out Hit hit) {
  hit.t = INF;
  hit.pos = vec3(0.0);
  hit.normal = vec3(0.0, 1.0, 0.0);
  hit.albedo = vec3(0.0);
  hit.emission = vec3(0.0);
  hit.material = MAT_DIFFUSE;
  hit.ior = 1.0;
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

void intersectTriangle(
  Ray ray,
  vec3 v0,
  vec3 v1,
  vec3 v2,
  vec3 albedo,
  int material,
  float ior,
  inout Hit hit
) {
  vec3 edge1 = v1 - v0;
  vec3 edge2 = v2 - v0;
  vec3 pvec = cross(ray.dir, edge2);
  float det = dot(edge1, pvec);

  if (abs(det) < 1e-6) {
    return;
  }

  float invDet = 1.0 / det;
  vec3 tvec = ray.origin - v0;
  float u = dot(tvec, pvec) * invDet;
  if (u < 0.0 || u > 1.0) {
    return;
  }

  vec3 qvec = cross(tvec, edge1);
  float v = dot(ray.dir, qvec) * invDet;
  if (v < 0.0 || u + v > 1.0) {
    return;
  }

  float t = dot(edge2, qvec) * invDet;
  if (!isCloser(t, hit)) {
    return;
  }

  vec3 pos = ray.origin + t * ray.dir;
  vec3 normal = normalize(cross(edge1, edge2));
  vec3 faceNormal = dot(ray.dir, normal) < 0.0 ? normal : -normal;
  commitHit(hit, t, pos, faceNormal, albedo, vec3(0.0));
  hit.material = material;
  hit.ior = ior;
}

void intersectPyramid(
  Ray ray,
  vec3 baseCenter,
  float halfX,
  float halfZ,
  float height,
  vec3 albedo,
  int material,
  float ior,
  inout Hit hit
) {
  vec3 p0 = baseCenter + vec3(-halfX, 0.0, -halfZ);
  vec3 p1 = baseCenter + vec3( halfX, 0.0, -halfZ);
  vec3 p2 = baseCenter + vec3( halfX, 0.0,  halfZ);
  vec3 p3 = baseCenter + vec3(-halfX, 0.0,  halfZ);
  vec3 apex = baseCenter + vec3(0.0, height, 0.0);

  // Four side faces.
  intersectTriangle(ray, p0, p1, apex, albedo, material, ior, hit);
  intersectTriangle(ray, p1, p2, apex, albedo, material, ior, hit);
  intersectTriangle(ray, p2, p3, apex, albedo, material, ior, hit);
  intersectTriangle(ray, p3, p0, apex, albedo, material, ior, hit);

  // Thin bottom, lifted slightly above the floor to avoid coplanar hits.
  intersectTriangle(ray, p0, p2, p1, albedo, material, ior, hit);
  intersectTriangle(ray, p0, p3, p2, albedo, material, ior, hit);
}

// A flat water interface closes the lower half of an ellipsoidal depression.
// Sharing its rim with the dry ground avoids floating water and open side walls.
void intersectPuddleGround(Ray ray, inout Hit hit) {
  vec3 center = vec3(0.0, 0.0, -0.2);
  vec3 radii = vec3(1.25, 0.08, 0.85);
  vec3 groundColor = vec3(0.24, 0.22, 0.19);

  if (abs(ray.dir.y) > 1e-5) {
    float t = -ray.origin.y / ray.dir.y;
    if (isCloser(t, hit)) {
      vec3 pos = ray.origin + t * ray.dir;
      vec2 footprint = (pos.xz - center.xz) / radii.xz;
      bool water = dot(footprint, footprint) < 1.0;
      // Keep the water normal outward even for rays exiting from below;
      // sampleDielectric uses its orientation to choose the two media.
      vec3 normal = vec3(0.0, 1.0, 0.0);
      commitHit(hit, t, pos, normal, groundColor, vec3(0.0));
      if (water) {
        hit.material = MAT_DIELECTRIC;
        hit.ior = WATER_IOR;
      }
    }
  }

  // Transform into a unit sphere without normalizing the direction, so t
  // stays in world units. Only the lower hemisphere is the submerged bed.
  vec3 origin = (ray.origin - center) / radii;
  vec3 direction = ray.dir / radii;
  float a = dot(direction, direction);
  float b = dot(origin, direction);
  float c = dot(origin, origin) - 1.0;
  float discriminant = b * b - a * c;
  if (discriminant < 0.0) return;
  float root = sqrt(discriminant);
  for (int i = 0; i < 2; ++i) {
    float t = (-b + (i == 0 ? -root : root)) / a;
    vec3 pos = ray.origin + t * ray.dir;
    if (isCloser(t, hit) && pos.y < center.y) {
      vec3 normal = -normalize((pos - center) / (radii * radii));
      commitHit(hit, t, pos, normal, groundColor, vec3(0.0));
    }
  }
}

bool intersectScene(Ray ray, out Hit hit) {
  initHit(hit);
  intersectPuddleGround(ray, hit);
  return hit.t < INF;
}

// Returns linear radiance for a normalized world-space direction. Broad sky
// features provide visible reflections without a tiny, noisy sun emitter.
// This is a procedural environment, not a physical atmosphere simulation.
vec3 environmentRadiance(vec3 direction) {
  float elevation = clamp(direction.y, 0.0, 1.0);
  vec3 horizon = vec3(1.25, 1.35, 1.5);
  vec3 zenith = vec3(0.28, 0.55, 1.0);
  vec3 sky = mix(horizon, zenith, pow(elevation, 0.55));

  // Smooth cloud patches vary with direction so a flat water surface has
  // recognizable reflected features. Keep them static for accumulation.
  float cloudA = pow(max(dot(direction, normalize(vec3(-0.7, 0.65, -0.3))), 0.0), 12.0);
  float cloudB = pow(max(dot(direction, normalize(vec3(0.55, 0.45, 0.7))), 0.0), 20.0);
  float clouds = smoothstep(0.15, 0.8, max(cloudA, cloudB));
  sky = mix(sky, vec3(2.2, 2.15, 2.05), clouds);

  // Ground geometry normally blocks the lower hemisphere; retain a finite
  // neutral value at the horizon and for any downward escaping rays.
  return mix(vec3(0.12, 0.1, 0.08), sky, smoothstep(-0.08, 0.02, direction.y));
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

float filmThicknessNm(vec3 position) {
  vec2 p = position.xz;
  float pattern = sin(3.2 * p.x + 1.5 * sin(2.7 * p.y))
                * cos(2.4 * p.y - 0.8 * p.x);
  return max(0.0, FILM_THICKNESS_NM + FILM_VARIATION_NM * pattern);
}

// Airy reflectance sums all internal reflections of a lossless parallel film.
// Signed amplitude coefficients retain interface phase flips (including the
// p-polarization sign change); squaring them too early loses interference.
vec3 airyReflectance(float r01, float r12, vec3 cosPhase) {
  float product = r01 * r12;
  return (vec3(r01 * r01 + r12 * r12) + 2.0 * product * cosPhase)
       / max(vec3(1.0 + product * product) + 2.0 * product * cosPhase, vec3(1e-7));
}

// Returns approximate RGB power reflectance for air/oil/water or the reversed
// stack. Three representative wavelengths are a prototype approximation,
// not spectral integration into a color-matching space. IORs are nondispersive.
vec3 thinFilmReflectance(float cosI, float n0, float n2, float thicknessNm) {
  float sin2I = max(0.0, 1.0 - cosI * cosI);
  float sin2Film = (n0 / OIL_IOR) * (n0 / OIL_IOR) * sin2I;
  float sin2Exit = (n0 / n2) * (n0 / n2) * sin2I;
  // OIL_IOR exceeds both air and water IOR, so the film has no evanescent
  // propagation here. If the exit medium cannot transmit, all power reflects.
  if (sin2Exit >= 1.0 || cosI <= 1e-6) return vec3(1.0);
  float cosFilm = sqrt(max(0.0, 1.0 - sin2Film));
  float cosExit = sqrt(max(0.0, 1.0 - sin2Exit));
  float rs01 = (n0 * cosI - OIL_IOR * cosFilm) / (n0 * cosI + OIL_IOR * cosFilm);
  float rs12 = (OIL_IOR * cosFilm - n2 * cosExit) / (OIL_IOR * cosFilm + n2 * cosExit);
  float rp01 = (OIL_IOR * cosI - n0 * cosFilm) / (OIL_IOR * cosI + n0 * cosFilm);
  float rp12 = (n2 * cosFilm - OIL_IOR * cosExit) / (n2 * cosFilm + OIL_IOR * cosExit);
  vec3 wavelengthsNm = vec3(650.0, 550.0, 450.0);
  vec3 cosPhase = cos(4.0 * PI * OIL_IOR * thicknessNm * cosFilm / wavelengthsNm);
  return clamp(0.5 * (airyReflectance(rs01, rs12, cosPhase)
                   + airyReflectance(rp01, rp12, cosPhase)), 0.0, 1.0);
}

// Samples a smooth coated interface and returns its Monte Carlo RGB weight.
// The nanometer film is evaluated optically, without extra geometric surfaces.
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

  vec3 reflection = thinFilmReflectance(cosTheta, etaI, etaT, filmThicknessNm(hit.pos));
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
  // Keep the orbit above the ground so the shallow water surface stays visible.
  float pitch = mix(0.45, 0.9, u_mouse.y);

  vec3 target = vec3(0.0, 0.0, -0.2 + u_cameraZOffset) + u_cameraOffset;
  float camDist = 3.3;
  vec3 camPos = target + vec3(
    sin(yaw) * cos(pitch),
    sin(pitch) * 0.9,
    cos(yaw) * cos(pitch)
  ) * camDist;

  mat3 cam = cameraBasis(target - camPos, vec3(0.0, 1.0, 0.0));

  Ray ray;
  ray.origin = camPos;
  ray.dir = normalize(cam * vec3(screen, 1.85));
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
