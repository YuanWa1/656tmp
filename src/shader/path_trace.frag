#version 300 es
precision highp float;
precision highp int;

in vec2 uv;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_cameraZOffset;
uniform sampler2D u_previousFrame;
uniform int u_frame;
uniform float u_time;

out vec4 outColor;

const int SAMPLES = 16;
const int MAX_BOUNCES = 18;

const float PI = 3.14159265359;
const float INF = 1e20;
const float EPS = 0.001;
const int MAT_DIFFUSE = 0;
const int MAT_DIELECTRIC = 1;
const float GLASS_IOR = 1.5;
const int RUSSIAN_ROULETTE_START = 3;
const float RUSSIAN_ROULETTE_SURVIVAL = 0.95;

const vec3 LIGHT_CENTER = vec3(0.0, 1.99, -0.2);
const vec3 LIGHT_NORMAL = vec3(0.0, -1.0, 0.0);
const vec3 LIGHT_EMISSION = vec3(25.0);
const vec2 LIGHT_X_RANGE = vec2(-0.33, 0.33);
const vec2 LIGHT_Z_RANGE = vec2(-0.65, -0.05);
const float LIGHT_AREA =
  (LIGHT_X_RANGE.y - LIGHT_X_RANGE.x) * (LIGHT_Z_RANGE.y - LIGHT_Z_RANGE.x);

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

bool intersectScene(Ray ray, out Hit hit) {
  initHit(hit);

  vec3 white = vec3(0.78);
  vec3 red = vec3(0.85, 0.2, 0.16);
  vec3 blue = vec3(0.28, 0.25, 0.75);

  intersectPlaneRect(ray, vec3(-1.2, 0.0, 0.0), vec3(1.0, 0.0, 0.0), vec2(0.0, -1.6), vec2(2.0, 1.0), 1, 2, blue, vec3(0.0), hit);
  intersectPlaneRect(ray, vec3(1.2, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec2(0.0, -1.6), vec2(2.0, 1.0), 1, 2, red, vec3(0.0), hit);
  intersectPlaneRect(ray, vec3(0.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec2(-1.2, -1.6), vec2(1.2, 1.0), 0, 2, white, vec3(0.0), hit);
  intersectPlaneRect(ray, vec3(0.0, 2.0, 0.0), vec3(0.0, -1.0, 0.0), vec2(-1.2, -1.6), vec2(1.2, 1.0), 0, 2, white, vec3(0.0), hit);
  intersectPlaneRect(ray, vec3(0.0, 0.0, -1.6), vec3(0.0, 0.0, 1.0), vec2(-1.2, 0.0), vec2(1.2, 2.0), 0, 1, white, vec3(0.0), hit);

  intersectPlaneRect(
    ray,
    LIGHT_CENTER,
    LIGHT_NORMAL,
    vec2(LIGHT_X_RANGE.x, LIGHT_Z_RANGE.x),
    vec2(LIGHT_X_RANGE.y, LIGHT_Z_RANGE.y),
    0,
    2,
    vec3(1.0),
    LIGHT_EMISSION,
    hit
  );

  intersectSphere(ray, vec3(-0.52, 0.42, -0.68), 0.42, vec3(0.92), MAT_DIFFUSE, 1.0, hit);
  intersectSphere(ray, vec3(0.45, 0.36, -0.58), 0.36, vec3(1.0), MAT_DIELECTRIC, GLASS_IOR, hit);
  intersectPyramid(
    ray,
    vec3(0.0, 0.0, -1.08),
    0.13,
    0.16,
    0.36,
    vec3(0.86, 0.68, 0.38),
    MAT_DIFFUSE,
    1.0,
    hit
  );

  return hit.t < INF;
}

bool visibleToLight(vec3 origin, vec3 dir, float lightDist) {
  Ray shadowRay;
  shadowRay.origin = origin;
  shadowRay.dir = dir;

  Hit shadowHit;
  if (!intersectScene(shadowRay, shadowHit)) {
    return true;
  }

  // Visible when the first hit is the sampled light, or no blocker appears
  // before the sampled light distance.
  if (length(shadowHit.emission) > 0.0 && shadowHit.t <= lightDist + EPS) {
    return true;
  }

  return shadowHit.t >= lightDist - EPS;
}

vec3 sampleAreaLight(Hit hit, inout uint rngState) {
  vec2 r = rand2(rngState);
  vec3 lightPos = vec3(
    mix(LIGHT_X_RANGE.x, LIGHT_X_RANGE.y, r.x),
    LIGHT_CENTER.y,
    mix(LIGHT_Z_RANGE.x, LIGHT_Z_RANGE.y, r.y)
  );

  vec3 toLight = lightPos - hit.pos;
  float dist2 = dot(toLight, toLight);
  float dist = sqrt(dist2);
  vec3 lightDir = toLight / max(dist, EPS);

  float cosSurface = max(dot(hit.normal, lightDir), 0.0);
  float cosLight = max(dot(LIGHT_NORMAL, -lightDir), 0.0);
  if (cosSurface <= 0.0 || cosLight <= 0.0) {
    return vec3(0.0);
  }

  vec3 shadowOrigin = hit.pos + hit.normal * EPS;
  if (!visibleToLight(shadowOrigin, lightDir, dist)) {
    return vec3(0.0);
  }

  return hit.albedo / PI * LIGHT_EMISSION * cosSurface * cosLight / dist2 * LIGHT_AREA;
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

float fresnelSchlick(float cosTheta, float etaI, float etaT) {
  float r0 = (etaI - etaT) / (etaI + etaT);
  r0 *= r0;
  return r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0);
}

vec3 sampleDielectric(Hit hit, Ray ray, inout uint rngState) {
  bool frontFace = dot(ray.dir, hit.normal) < 0.0;
  vec3 normal = frontFace ? hit.normal : -hit.normal;
  float etaI = frontFace ? 1.0 : hit.ior;
  float etaT = frontFace ? hit.ior : 1.0;
  float eta = etaI / etaT;

  float cosTheta = min(dot(-ray.dir, normal), 1.0);
  float sin2Theta = max(0.0, 1.0 - cosTheta * cosTheta);
  bool cannotRefract = eta * eta * sin2Theta > 1.0;
  float fresnel = fresnelSchlick(cosTheta, etaI, etaT);

  if (cannotRefract || rand(rngState) < fresnel) {
    return reflect(ray.dir, normal);
  }

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
  float pitch = mix(-0.18, 0.18, u_mouse.y);

  vec3 target = vec3(0.0, 0.9, -0.75 + u_cameraZOffset);
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
  bool allowEmitterHit = true;

  for (int bounce = 0; bounce < MAX_BOUNCES; ++bounce) {
    rngState ^= makeSeed(pixel, sampleIndex, bounce);

    Hit hit;
    if (!intersectScene(ray, hit)) {
      break;
    }

    if (length(hit.emission) > 0.0) {
      if (allowEmitterHit) {
        radiance += throughput * hit.emission;
      }
      break;
    }

    if (hit.material == MAT_DIELECTRIC) {
      if (!surviveRussianRoulette(bounce, throughput, rngState)) {
        break;
      }

      vec3 nextDir = sampleDielectric(hit, ray, rngState);
      vec3 offsetNormal = dot(nextDir, hit.normal) > 0.0 ? hit.normal : -hit.normal;
      ray.origin = hit.pos + offsetNormal * EPS;
      ray.dir = normalize(nextDir);
      allowEmitterHit = true;
      continue;
    }

    radiance += throughput * sampleAreaLight(hit, rngState);

    if (!surviveRussianRoulette(bounce, throughput, rngState)) {
      break;
    }

    vec3 nextDir = cosineWeightedHemisphere(hit.normal, rngState);
    throughput *= hit.albedo;

    ray.origin = hit.pos + hit.normal * EPS;
    ray.dir = nextDir;
    allowEmitterHit = false;
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
