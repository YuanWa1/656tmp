#version 300 es

precision highp float;
precision highp sampler2D;

in vec2 uv;

out vec4 out_color;

uniform vec2 u_resolution;
uniform vec2 u_mouse;

uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform sampler2D u_tex2;
uniform sampler2D u_tex3;
uniform sampler2D u_tex4;
uniform sampler2D u_tex5;
uniform sampler2D u_tex6;
uniform sampler2D u_tex7;

const float PI = 3.14159265359;
const float EPSILON = 0.001;
const float FAR_CLIP = 1.0e5;

const int MAT_FLOOR = 0;
const int MAT_MIRROR = 1;
const int MAT_GLASS = 2;
const int MAT_UNION = 3;
const int MAT_INTERSECTION = 4;
const int MAT_DIFFERENCE = 5;
const int MAT_BACK_WALL = 6;

const int CSG_UNION = 0;
const int CSG_INTERSECTION = 1;
const int CSG_DIFFERENCE = 2;

const int MAX_DEPTH = 4;
const int MAX_STACK = 18;
const int SHADOW_SAMPLES = 4;

struct Hit {
    bool hit;
    float t;
    vec3 position;
    vec3 normal;
    int materialId;
};

struct Interval {
    bool valid;
    float tNear;
    float tFar;
    vec3 nNear;
    vec3 nFar;
};

struct MaterialInfo {
    vec3 baseColor;
    float reflectivity;
    float transparency;
    float ior;
    float specularStrength;
    float shininess;
    float shadowOpacity;
};

Hit makeNoHit() {
    return Hit(false, FAR_CLIP, vec3(0.0), vec3(0.0, 1.0, 0.0), -1);
}

float maxComponent(vec3 v) {
    return max(v.x, max(v.y, v.z));
}

float saturate(float x) {
    return clamp(x, 0.0, 1.0);
}

vec2 safeResolution() {
    return max(u_resolution, vec2(1.0));
}

bool evaluateCSG(int op, bool inA, bool inB) {
    if (op == CSG_UNION) {
        return inA || inB;
    }
    if (op == CSG_INTERSECTION) {
        return inA && inB;
    }
    return inA && !inB;
}

Interval sphereInterval(vec3 ro, vec3 rd, vec3 center, float radius) {
    Interval interval;
    interval.valid = false;
    interval.tNear = FAR_CLIP;
    interval.tFar = FAR_CLIP;
    interval.nNear = vec3(0.0);
    interval.nFar = vec3(0.0);

    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;

    if (h < 0.0) {
        return interval;
    }

    float sqrtH = sqrt(h);
    float t0 = -b - sqrtH;
    float t1 = -b + sqrtH;

    if (t1 <= EPSILON) {
        return interval;
    }

    interval.valid = true;
    interval.tNear = t0;
    interval.tFar = t1;
    interval.nNear = normalize(ro + rd * t0 - center);
    interval.nFar = normalize(ro + rd * t1 - center);
    return interval;
}

Hit intersectSphere(vec3 ro, vec3 rd, vec3 center, float radius, int materialId) {
    Hit hit = makeNoHit();
    Interval interval = sphereInterval(ro, rd, center, radius);

    if (!interval.valid) {
        return hit;
    }

    float t = interval.tNear > EPSILON ? interval.tNear : interval.tFar;
    if (t <= EPSILON) {
        return hit;
    }

    hit.hit = true;
    hit.t = t;
    hit.position = ro + rd * t;
    hit.normal = normalize(hit.position - center);
    hit.materialId = materialId;
    return hit;
}

Hit intersectPlane(vec3 ro, vec3 rd, vec3 point, vec3 normal, int materialId) {
    Hit hit = makeNoHit();
    float denom = dot(normal, rd);

    if (abs(denom) < 1.0e-5) {
        return hit;
    }

    float t = dot(point - ro, normal) / denom;
    if (t <= EPSILON) {
        return hit;
    }

    hit.hit = true;
    hit.t = t;
    hit.position = ro + rd * t;
    hit.normal = normalize(normal);
    hit.materialId = materialId;
    return hit;
}

Hit intersectCSGSpheres(
    vec3 ro,
    vec3 rd,
    int op,
    vec3 centerA,
    float radiusA,
    vec3 centerB,
    float radiusB,
    int materialId
) {
    Hit hit = makeNoHit();
    Interval a = sphereInterval(ro, rd, centerA, radiusA);
    Interval b = sphereInterval(ro, rd, centerB, radiusB);

    bool inA = dot(ro - centerA, ro - centerA) < radiusA * radiusA;
    bool inB = dot(ro - centerB, ro - centerB) < radiusB * radiusB;
    bool insideResult = evaluateCSG(op, inA, inB);

    float eventT[4];
    vec3 eventN[4];
    int eventSource[4];
    int eventCount = 0;

    if (a.valid) {
        eventT[eventCount] = a.tNear;
        eventN[eventCount] = a.nNear;
        eventSource[eventCount] = 0;
        eventCount += 1;

        eventT[eventCount] = a.tFar;
        eventN[eventCount] = a.nFar;
        eventSource[eventCount] = 0;
        eventCount += 1;
    }

    if (b.valid) {
        eventT[eventCount] = b.tNear;
        eventN[eventCount] = b.nNear;
        eventSource[eventCount] = 1;
        eventCount += 1;

        eventT[eventCount] = b.tFar;
        eventN[eventCount] = b.nFar;
        eventSource[eventCount] = 1;
        eventCount += 1;
    }

    for (int i = 0; i < 4; i += 1) {
        if (i >= eventCount) {
            break;
        }
        for (int j = i + 1; j < 4; j += 1) {
            if (j >= eventCount) {
                break;
            }
            if (eventT[j] < eventT[i]) {
                float tSwap = eventT[i];
                eventT[i] = eventT[j];
                eventT[j] = tSwap;

                vec3 nSwap = eventN[i];
                eventN[i] = eventN[j];
                eventN[j] = nSwap;

                int srcSwap = eventSource[i];
                eventSource[i] = eventSource[j];
                eventSource[j] = srcSwap;
            }
        }
    }

    for (int i = 0; i < 4; i += 1) {
        if (i >= eventCount) {
            break;
        }

        bool oldState = insideResult;
        if (eventSource[i] == 0) {
            inA = !inA;
        } else {
            inB = !inB;
        }
        insideResult = evaluateCSG(op, inA, inB);

        if (eventT[i] <= EPSILON) {
            continue;
        }

        if (oldState != insideResult) {
            vec3 outwardNormal = eventN[i];
            if (op == CSG_DIFFERENCE && eventSource[i] == 1) {
                outwardNormal = -outwardNormal;
            }

            hit.hit = true;
            hit.t = eventT[i];
            hit.position = ro + rd * hit.t;
            hit.normal = normalize(outwardNormal);
            hit.materialId = materialId;
            return hit;
        }
    }

    return hit;
}

vec3 checkerColor(vec3 position) {
    float checker = mod(floor(position.x * 1.35) + floor(position.z * 1.35), 2.0);
    vec3 tile = mix(vec3(0.16, 0.15, 0.14), vec3(0.33, 0.31, 0.28), checker);
    vec3 tex = texture(u_tex0, fract(position.xz * 0.14)).rgb;
    return mix(tile, tex, 0.35);
}

vec3 wallColor(vec3 position) {
    vec2 wallUV = fract(position.xy * vec2(0.12, 0.12) + vec2(0.3, 0.2));
    vec3 tex = texture(u_tex1, wallUV).rgb;
    vec2 gridUV = fract(position.xy * 0.4);
    float stripe = smoothstep(0.44, 0.5, abs(gridUV.x - 0.5));
    vec3 base = mix(vec3(0.18, 0.2, 0.24), vec3(0.42, 0.46, 0.52), stripe);
    return mix(base, tex, 0.22);
}

MaterialInfo getMaterialInfo(int materialId, vec3 position, vec3 normal) {
    MaterialInfo material;
    material.baseColor = vec3(0.75);
    material.reflectivity = 0.0;
    material.transparency = 0.0;
    material.ior = 1.0;
    material.specularStrength = 0.25;
    material.shininess = 48.0;
    material.shadowOpacity = 1.0;

    if (materialId == MAT_FLOOR) {
        material.baseColor = checkerColor(position);
        material.specularStrength = 0.18;
        material.shininess = 42.0;
        return material;
    }

    if (materialId == MAT_MIRROR) {
        material.baseColor = vec3(0.86, 0.89, 0.94);
        material.reflectivity = 0.82;
        material.specularStrength = 0.9;
        material.shininess = 128.0;
        return material;
    }

    if (materialId == MAT_GLASS) {
        material.baseColor = vec3(0.78, 0.94, 1.0);
        material.transparency = 1.0;
        material.ior = 1.52;
        material.specularStrength = 1.0;
        material.shininess = 180.0;
        material.shadowOpacity = 0.5;
        return material;
    }

    if (materialId == MAT_UNION) {
        material.baseColor = vec3(0.76, 0.35, 0.3);
        material.specularStrength = 0.25;
        material.shininess = 56.0;
        return material;
    }

    if (materialId == MAT_INTERSECTION) {
        material.baseColor = vec3(0.24, 0.72, 0.64);
        material.specularStrength = 0.32;
        material.shininess = 64.0;
        return material;
    }

    if (materialId == MAT_DIFFERENCE) {
        material.baseColor = vec3(0.84, 0.72, 0.24);
        material.specularStrength = 0.28;
        material.shininess = 60.0;
        return material;
    }

    material.baseColor = wallColor(position);
    material.specularStrength = 0.08;
    material.shininess = 24.0;
    return material;
}

vec3 getLightCenter() {
    vec2 mouse = u_mouse / safeResolution();
    return vec3(
        mix(-2.8, 2.8, mouse.x),
        mix(2.8, 5.6, mouse.y),
        1.5
    );
}

vec3 getSunDirection() {
    return normalize(vec3(-0.45, 0.85, -0.3));
}

vec3 sampleEnvironment(vec3 rd) {
    float horizon = smoothstep(-0.2, 0.35, rd.y);
    vec3 skyLow = vec3(0.72, 0.78, 0.86);
    vec3 skyHigh = vec3(0.22, 0.39, 0.68);
    vec3 ground = vec3(0.08, 0.075, 0.07);

    vec2 envUV = vec2(
        atan(rd.z, rd.x) / (2.0 * PI) + 0.5,
        acos(clamp(rd.y, -1.0, 1.0)) / PI
    );
    vec3 envTint = texture(u_tex1, fract(envUV)).rgb;

    vec3 sky = mix(skyLow, skyHigh, saturate(pow(1.0 - horizon, 1.25)));
    sky = mix(sky, envTint, 0.18);

    float sun = pow(max(dot(rd, getSunDirection()), 0.0), 300.0);
    return mix(ground, sky, horizon) + sun * vec3(3.0, 2.6, 2.2);
}

float fresnelSchlick(float cosTheta, float etaI, float etaT) {
    float r0 = (etaI - etaT) / (etaI + etaT);
    r0 *= r0;
    return r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0);
}

Hit traceScene(vec3 ro, vec3 rd) {
    Hit closest = makeNoHit();

    Hit candidate = intersectPlane(ro, rd, vec3(0.0, -1.15, 0.0), vec3(0.0, 1.0, 0.0), MAT_FLOOR);
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectPlane(ro, rd, vec3(0.0, 0.0, 8.2), vec3(0.0, 0.0, -1.0), MAT_BACK_WALL);
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectSphere(ro, rd, vec3(-1.8, 0.9, 2.8), 0.95, MAT_MIRROR);
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectSphere(ro, rd, vec3(1.6, -0.2, 3.2), 0.92, MAT_GLASS);
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectCSGSpheres(
        ro,
        rd,
        CSG_UNION,
        vec3(-3.2, -0.38, 5.2),
        0.72,
        vec3(-2.6, 0.02, 4.78),
        0.68,
        MAT_UNION
    );
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectCSGSpheres(
        ro,
        rd,
        CSG_INTERSECTION,
        vec3(2.75, -0.05, 5.0),
        0.8,
        vec3(2.25, 0.2, 4.65),
        0.78,
        MAT_INTERSECTION
    );
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    candidate = intersectCSGSpheres(
        ro,
        rd,
        CSG_DIFFERENCE,
        vec3(0.2, 0.02, 4.75),
        1.0,
        vec3(0.72, 0.28, 4.36),
        0.66,
        MAT_DIFFERENCE
    );
    if (candidate.hit && candidate.t < closest.t) {
        closest = candidate;
    }

    return closest;
}

vec2 areaLightOffset(int sampleIndex) {
    if (sampleIndex == 0) {
        return vec2(-0.35, -0.2);
    }
    if (sampleIndex == 1) {
        return vec2(0.35, -0.15);
    }
    if (sampleIndex == 2) {
        return vec2(-0.18, 0.32);
    }
    return vec2(0.22, 0.28);
}

float shadowVisibilityToLight(vec3 point, vec3 normal, vec3 lightPos) {
    vec3 toLight = lightPos - point;
    float maxDistance = length(toLight);
    vec3 shadowDir = toLight / maxDistance;
    vec3 shadowOrigin = point + normal * EPSILON * 4.0;

    float visibility = 1.0;
    float travelled = 0.0;

    for (int step = 0; step < 3; step += 1) {
        Hit blocker = traceScene(shadowOrigin, shadowDir);
        if (!blocker.hit || blocker.t + travelled >= maxDistance) {
            break;
        }

        MaterialInfo blockerMaterial = getMaterialInfo(blocker.materialId, blocker.position, blocker.normal);
        if (blockerMaterial.transparency > 0.0) {
            visibility *= blockerMaterial.shadowOpacity;
            travelled += blocker.t;
            shadowOrigin = blocker.position + shadowDir * EPSILON * 6.0;
            continue;
        }

        visibility = 0.0;
        break;
    }

    return visibility;
}

vec3 directLighting(Hit hit, MaterialInfo material, vec3 viewDir) {
    vec3 lightCenter = getLightCenter();
    vec3 lightColor = vec3(1.35, 1.18, 1.02);
    vec3 color = material.baseColor * (0.045 + 0.035 * saturate(hit.normal.y * 0.5 + 0.5));

    for (int i = 0; i < SHADOW_SAMPLES; i += 1) {
        vec2 offset = areaLightOffset(i);
        vec3 lightPos = lightCenter + vec3(offset.x * 0.7, 0.0, offset.y * 0.7);
        vec3 lightVec = lightPos - hit.position;
        vec3 lightDir = normalize(lightVec);

        float nDotL = max(dot(hit.normal, lightDir), 0.0);
        if (nDotL <= 0.0) {
            continue;
        }

        float visibility = shadowVisibilityToLight(hit.position, hit.normal, lightPos);
        vec3 halfDir = normalize(lightDir + viewDir);
        float specular = pow(max(dot(hit.normal, halfDir), 0.0), material.shininess) * material.specularStrength;

        vec3 diffuse = (1.0 - material.transparency) * material.baseColor * nDotL;
        vec3 specularColor = mix(vec3(1.0), material.baseColor, 0.12 * material.reflectivity);
        color += visibility * lightColor * (diffuse + specularColor * specular) / float(SHADOW_SAMPLES);
    }

    float skyBounce = 0.3 + 0.7 * saturate(hit.normal.y);
    color += material.baseColor * vec3(0.07, 0.1, 0.13) * skyBounce * (1.0 - 0.6 * material.transparency);
    return color;
}

vec3 traceRays(vec3 ro, vec3 rd) {
    vec3 accumulated = vec3(0.0);

    vec3 stackOrigin[MAX_STACK];
    vec3 stackDirection[MAX_STACK];
    vec3 stackThroughput[MAX_STACK];
    float stackIor[MAX_STACK];
    int stackDepth[MAX_STACK];

    int stackSize = 0;
    stackOrigin[stackSize] = ro;
    stackDirection[stackSize] = rd;
    stackThroughput[stackSize] = vec3(1.0);
    stackIor[stackSize] = 1.0;
    stackDepth[stackSize] = 0;
    stackSize += 1;

    for (int iter = 0; iter < MAX_STACK; iter += 1) {
        if (stackSize <= 0) {
            break;
        }

        stackSize -= 1;

        vec3 rayOrigin = stackOrigin[stackSize];
        vec3 rayDirection = normalize(stackDirection[stackSize]);
        vec3 throughput = stackThroughput[stackSize];
        float currentIor = stackIor[stackSize];
        int depth = stackDepth[stackSize];

        if (maxComponent(throughput) < 0.01) {
            continue;
        }

        Hit hit = traceScene(rayOrigin, rayDirection);
        if (!hit.hit) {
            accumulated += throughput * sampleEnvironment(rayDirection);
            continue;
        }

        MaterialInfo material = getMaterialInfo(hit.materialId, hit.position, hit.normal);
        vec3 viewDir = normalize(-rayDirection);
        vec3 localLight = directLighting(hit, material, viewDir);

        if (material.transparency > 0.0) {
            accumulated += throughput * localLight * 0.08;
        } else {
            accumulated += throughput * localLight * (1.0 - material.reflectivity);
        }

        if (depth >= MAX_DEPTH) {
            continue;
        }

        if (material.transparency > 0.0) {
            bool entering = dot(rayDirection, hit.normal) < 0.0;
            vec3 faceNormal = entering ? hit.normal : -hit.normal;
            float nextIor = entering ? material.ior : 1.0;
            float eta = currentIor / nextIor;
            float cosTheta = saturate(dot(-rayDirection, faceNormal));
            float fresnel = fresnelSchlick(cosTheta, currentIor, nextIor);

            vec3 reflectDir = normalize(reflect(rayDirection, faceNormal));
            vec3 reflectWeight = throughput * fresnel;

            if (stackSize < MAX_STACK && maxComponent(reflectWeight) > 0.01) {
                stackOrigin[stackSize] = hit.position + reflectDir * EPSILON * 6.0;
                stackDirection[stackSize] = reflectDir;
                stackThroughput[stackSize] = reflectWeight;
                stackIor[stackSize] = currentIor;
                stackDepth[stackSize] = depth + 1;
                stackSize += 1;
            }

            vec3 refractDir = refract(rayDirection, faceNormal, eta);
            if (length(refractDir) > 0.0) {
                vec3 transmittance = mix(vec3(1.0), material.baseColor, 0.22);
                vec3 refractWeight = throughput * (1.0 - fresnel) * transmittance;

                if (stackSize < MAX_STACK && maxComponent(refractWeight) > 0.01) {
                    stackOrigin[stackSize] = hit.position + refractDir * EPSILON * 6.0;
                    stackDirection[stackSize] = normalize(refractDir);
                    stackThroughput[stackSize] = refractWeight;
                    stackIor[stackSize] = nextIor;
                    stackDepth[stackSize] = depth + 1;
                    stackSize += 1;
                }
            }

            continue;
        }

        if (material.reflectivity > 0.08) {
            vec3 reflectDir = normalize(reflect(rayDirection, hit.normal));
            vec3 reflectTint = mix(vec3(1.0), material.baseColor, 0.15);
            vec3 reflectWeight = throughput * material.reflectivity * reflectTint;

            if (stackSize < MAX_STACK && maxComponent(reflectWeight) > 0.01) {
                stackOrigin[stackSize] = hit.position + reflectDir * EPSILON * 6.0;
                stackDirection[stackSize] = reflectDir;
                stackThroughput[stackSize] = reflectWeight;
                stackIor[stackSize] = currentIor;
                stackDepth[stackSize] = depth + 1;
                stackSize += 1;
            }
        }
    }

    return accumulated;
}

void main() {
    vec2 resolution = safeResolution();
    float aspect = resolution.x / resolution.y;

    vec2 p = uv * 2.0 - 1.0;
    p.x *= aspect;

    vec3 cameraOrigin = vec3(0.0, 0.35, -6.2);
    vec3 cameraTarget = vec3(0.0, -0.05, 4.0);
    vec3 forward = normalize(cameraTarget - cameraOrigin);
    vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
    vec3 up = normalize(cross(right, forward));

    float focalLength = 1.7;
    vec3 rayDirection = normalize(forward * focalLength + right * p.x + up * p.y);

    vec3 color = traceRays(cameraOrigin, rayDirection);
    color = color / (color + vec3(1.0));
    color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));

    out_color = vec4(color, 1.0);
}
