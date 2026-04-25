#version 300 es
precision highp float;

in vec2 uv;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;

out vec4 outColor;

const float PI = 3.14159265359;
const float INF = 1e20;

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
  float smoothness;
};

void initHit(out Hit hit) {
  hit.t = INF;
  hit.pos = vec3(0.0);
  hit.normal = vec3(0.0, 1.0, 0.0);
  hit.albedo = vec3(0.0);
  hit.emission = vec3(0.0);
  hit.smoothness = 0.0;
}

bool isCloser(float t, Hit hit) {
  return t > 0.001 && t < hit.t;
}

void commitHit(
  inout Hit hit,
  float t,
  vec3 pos,
  vec3 normal,
  vec3 albedo,
  vec3 emission,
  float smoothness
) {
  hit.t = t;
  hit.pos = pos;
  hit.normal = normal;
  hit.albedo = albedo;
  hit.emission = emission;
  hit.smoothness = smoothness;
}

void intersectSphere(
  Ray ray,
  vec3 center,
  float radius,
  vec3 albedo,
  float smoothness,
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
  if (t <= 0.001) {
    t = -b + sqrtH;
  }
  if (!isCloser(t, hit)) {
    return;
  }

  vec3 pos = ray.origin + t * ray.dir;
  vec3 normal = normalize(pos - center);
  commitHit(hit, t, pos, normal, albedo, vec3(0.0), smoothness);
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
  float smoothness,
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
  commitHit(hit, t, pos, faceNormal, albedo, emission, smoothness);
}

bool intersectScene(Ray ray, out Hit hit) {
  initHit(hit);

  vec3 white = vec3(0.78);
  vec3 red = vec3(0.85, 0.2, 0.16);
  vec3 blue = vec3(0.28, 0.25, 0.75);

  intersectPlaneRect(ray, vec3(-1.2, 0.0, 0.0), vec3(1.0, 0.0, 0.0), vec2(0.0, -1.6), vec2(2.0, 1.0), 1, 2, blue, vec3(0.0), 0.0, hit);
  intersectPlaneRect(ray, vec3(1.2, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec2(0.0, -1.6), vec2(2.0, 1.0), 1, 2, red, vec3(0.0), 0.0, hit);
  intersectPlaneRect(ray, vec3(0.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec2(-1.2, -1.6), vec2(1.2, 1.0), 0, 2, white, vec3(0.0), 0.0, hit);
  intersectPlaneRect(ray, vec3(0.0, 2.0, 0.0), vec3(0.0, -1.0, 0.0), vec2(-1.2, -1.6), vec2(1.2, 1.0), 0, 2, white, vec3(0.0), 0.0, hit);
  intersectPlaneRect(ray, vec3(0.0, 0.0, -1.6), vec3(0.0, 0.0, 1.0), vec2(-1.2, 0.0), vec2(1.2, 2.0), 0, 1, white, vec3(0.0), 0.0, hit);

  intersectPlaneRect(
    ray,
    vec3(0.0, 1.99, -0.2),
    vec3(0.0, -1.0, 0.0),
    vec2(-0.33, -0.65),
    vec2(0.33, -0.05),
    0,
    2,
    vec3(1.0),
    vec3(18.0),
    0.0,
    hit
  );

  intersectSphere(ray, vec3(-0.52, 0.42, -0.68), 0.42, vec3(0.92), 0.65, hit);
  intersectSphere(ray, vec3(0.45, 0.36, -0.58), 0.36, vec3(0.9, 0.9, 0.94), 0.9, hit);

  return hit.t < INF;
}

bool isOccluded(vec3 origin, vec3 dir, float maxDist) {
  Ray ray;
  ray.origin = origin;
  ray.dir = dir;

  Hit shadowHit;
  if (!intersectScene(ray, shadowHit)) {
    return false;
  }

  return shadowHit.t < maxDist;
}

vec3 shade(Hit hit, Ray ray) {
  vec3 color = hit.emission;

  vec3 lightPos = vec3(0.0, 1.99, -0.35);
  vec3 lightEmission = vec3(18.0);
  vec3 toLight = lightPos - hit.pos;
  float distToLight = length(toLight);
  vec3 lightDir = toLight / distToLight;

  float nDotL = max(dot(hit.normal, lightDir), 0.0);
  if (nDotL > 0.0 && !isOccluded(hit.pos + hit.normal * 0.01, lightDir, distToLight - 0.02)) {
    float attenuation = 1.0 / (1.0 + 0.35 * distToLight * distToLight);
    vec3 diffuse = hit.albedo * lightEmission * nDotL * attenuation;

    vec3 viewDir = normalize(-ray.dir);
    vec3 halfDir = normalize(lightDir + viewDir);
    float specPower = mix(8.0, 120.0, hit.smoothness);
    float specStrength = mix(0.04, 0.25, hit.smoothness);
    float specular = pow(max(dot(hit.normal, halfDir), 0.0), specPower) * specStrength;

    color += diffuse + lightEmission * specular * attenuation;
  }

  vec3 ambient = hit.albedo * vec3(0.02, 0.022, 0.025);
  color += ambient;

  float facing = clamp(0.5 + 0.5 * dot(hit.normal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
  color *= mix(vec3(0.92), vec3(1.08), facing);

  return color;
}

mat3 cameraBasis(vec3 forward, vec3 up) {
  vec3 f = normalize(forward);
  vec3 r = normalize(cross(f, up));
  vec3 u = cross(r, f);
  return mat3(r, u, f);
}

void main() {
  vec2 screen = uv * 2.0 - 1.0;
  screen.x *= u_resolution.x / max(u_resolution.y, 1.0);

  float yaw = mix(-0.35, 0.35, u_mouse.x);
  float pitch = mix(-0.08, 0.18, u_mouse.y);

  vec3 target = vec3(0.0, 0.9, -0.75);
  float camDist = 3.3;
  vec3 camPos = target + vec3(
    sin(yaw) * cos(pitch),
    sin(pitch) * 0.9,
    cos(yaw) * cos(pitch)
  ) * camDist;

  mat3 cam = cameraBasis(target - camPos, vec3(0.0, 1.0, 0.0));
  vec3 rayDir = normalize(cam * vec3(screen, 1.85));

  Ray ray;
  ray.origin = camPos;
  ray.dir = rayDir;

  Hit hit;
  vec3 color;
  if (intersectScene(ray, hit)) {
    color = shade(hit, ray);
  } else {
    float sky = 0.5 + 0.5 * rayDir.y;
    color = mix(vec3(0.02, 0.02, 0.025), vec3(0.08, 0.09, 0.12), sky);
  }

  color = pow(color, vec3(1.0 / 2.2));
  outColor = vec4(color, 1.0);
}
