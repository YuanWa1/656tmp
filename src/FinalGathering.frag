#version 300 es

precision highp float;
precision highp sampler2D;

in vec2 uv;

out vec4 out_color;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_time;

uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform sampler2D u_tex2;
uniform sampler2D u_tex3;
uniform sampler2D u_tex4;
uniform sampler2D u_tex5;
uniform sampler2D u_tex6;
uniform sampler2D u_tex7;

const float pi = 3.1416;

struct LocalCoord {
    vec3 P;
    vec3 N[3];
    float s[3];
};

struct EnvironmentSphere {
    LocalCoord L;
    vec2 uv;
};

struct Sphere {
    float R;
    vec3 P;
    LocalCoord L;
    vec4 ambient;
    vec4 dif;
    vec4 highlight;
    float Ks;
    float ior;
};

struct Ray {
    vec3 P;
    vec3 N;
};

struct HemiSphere {
    vec3 N[100];
    int M;
};

struct Refraction {
    vec3 R;
    vec3 T;
    float F;
};

struct Shading_Point_Properties {
    vec3 P;
    vec3 N;
    vec4 ambient;
    vec4 dif;
    vec4 highlight;
    float K_s;
    float ior;
    int name;
};

vec2 safeResolution() {
    return max(u_resolution, vec2(1.0));
}

vec2 random2Dvec(vec2 value) {
    float valuex = 2.0 * fract(439029.0 * sin(dot(value, vec2(85.38, 9.38532)))) - 1.0;
    float valuey = 2.0 * fract(439029.0 * sin(dot(value, vec2(35.383, -7.38532)))) - 1.0;
    return vec2(valuex, valuey);
}

vec3 random3Dvec(vec2 value) {
    float valuex = 2.0 * fract(439029.0 * sin(dot(value, vec2(85.38, 9.38532)))) - 1.0;
    float valuey = 2.0 * fract(439029.0 * sin(dot(value, vec2(35.383, -7.38532)))) - 1.0;
    float valuez = 0.0 * (10.0 * fract(329029.0 * sin(dot(value, vec2(-21.383, -3.38532)))) - 1.0);
    return vec3(0.7, 0.3, 0.1) + 0.01 * vec3(valuex, valuey, valuez);
}

vec2 TexMap_Sphere(vec3 N[3], vec3 N_tex) {
    vec2 uvSphere;
    float x = dot(N[0], N_tex);
    float y = dot(N[1], N_tex);
    float z = clamp(-dot(N[2], N_tex), -1.0, 1.0);
    uvSphere.y = acos(z) / pi;
    uvSphere.x = fract(atan(x, y) / (2.0 * pi) + 1.0);
    return uvSphere;
}

LocalCoord TimeBasedCoord(float speed) {
    LocalCoord L;
    vec2 resolution = safeResolution();
    vec3 V1 = vec3(cos(u_time * speed), 0.0, sin(u_time * speed));
    vec3 V2 = vec3(0.0, 0.5, 0.1);

    L.P = vec3(0.0);
    L.N[2] = normalize(V2);

    vec3 V0 = cross(V1, V2);
    L.N[0] = normalize(V0);
    L.N[1] = cross(L.N[2], L.N[0]);
    L.s[0] = u_mouse.x;
    L.s[1] = u_mouse.x * resolution.y / resolution.x;
    L.s[2] = 300.0;
    return L;
}

float ComputeIntersection(Ray RI, Sphere SI) {
    float B = dot(RI.N, SI.P - RI.P);
    float C = dot(RI.P - SI.P, RI.P - SI.P) - SI.R * SI.R;
    float delta = B * B - C;
    float t = -1.0;
    if (delta > 0.0 && B > 0.0) {
        t = B - sqrt(delta);
    }
    return t;
}

float ComputeSoftShadow(Ray RI, Sphere SI, float softness) {
    float a = softness;
    float B = dot(RI.N, SI.P - RI.P);
    float C = dot(RI.P - SI.P, RI.P - SI.P) - a * a * SI.R * SI.R;
    float delta = B * B - C;
    float t = -1.0;

    if (delta > 0.0 && B > 0.0) {
        if (C < 0.0) {
            t = sqrt(delta) / (2.0 * a * SI.R) - 1.0;
        } else {
            t = 1.0 - sqrt(delta) / (2.0 * a * SI.R);
        }
        t = pow(t, 2.0);
        t = smoothstep(0.0, 1.0, t);
    }

    return t;
}

Refraction ComputeRefractionComponents(vec3 N, vec3 V, float ior) {
    Refraction Data;
    float fc[3] = float[3](0.1, 0.0, 2.50);
    float Cos = dot(N, -V);

    Data.R = V + 2.0 * Cos * N;
    Data.T = 1.0 / ior * (-V + (Cos - sqrt(Cos * Cos - 1.0 + ior * ior)) * N);
    Data.F = fc[2] * (1.0 - Cos) * (1.0 - Cos) + fc[1] * 2.0 * Cos * (1.0 - Cos) + fc[0] * Cos * Cos;
    Data.F = clamp(Data.F, 0.0, 1.0);
    return Data;
}

vec3 compute_HS_Orientation(vec3 N, int j, vec2 value, HemiSphere HS) {
    vec3 N2t = N;
    vec3 V1 = random3Dvec(value);
    vec3 V0 = cross(V1, N2t);
    vec3 N0t = normalize(V0);
    vec3 N1t = cross(N2t, N0t);
    vec3 Dir = HS.N[j];
    return Dir.x * N0t + Dir.y * N1t + Dir.z * N2t;
}

vec4 ComputeRefractionColor(vec3 N[3], Refraction Obj, float blur) {
    vec2 uvTex = TexMap_Sphere(N, Obj.R);
    vec4 spec = textureLod(u_tex0, uvTex, blur);
    uvTex = TexMap_Sphere(N, -Obj.T);
    vec4 refractCol = textureLod(u_tex0, uvTex, blur);
    return (1.0 - Obj.F) * refractCol + Obj.F * spec;
}

HemiSphere IglooSampleCreate(int noL1, vec2 value, float amount) {
    int noL0;
    int count = 0;
    float theta;
    float phi;
    HemiSphere Igloo;

    for (float vi = 0.1; vi < 0.5; vi += 0.4 / float(noL1)) {
        noL0 = int(1.0 + 4.0 * float(noL1) * sqrt(1.0 - sin(pi * vi) * sin(pi * vi)));
        for (float ui = 0.0; ui < 1.2; ui += 1.0 / float(noL0)) {
            vec2 rand = random2Dvec(value);
            theta = 2.0 * pi * (ui + amount * rand.x);
            phi = pi * (vi + amount * rand.y);
            Igloo.N[count] = vec3(sin(theta) * sin(phi), cos(theta) * sin(phi), cos(phi));
            count += 1;
        }
    }

    Igloo.M = count;
    return Igloo;
}

vec4 powcolor(vec4 col0, vec4 col1, vec4 col2) {
    col0 += col1;
    col0.r = pow(col0.r, col2.r);
    col0.g = pow(col0.g, col2.g);
    col0.b = pow(col0.b, col2.b);
    return col0;
}

Shading_Point_Properties Compute_Shading_Properties(Ray RI, Sphere SI, float t, int i) {
    Shading_Point_Properties SPP;
    SPP.P = RI.P + t * RI.N;
    SPP.N = (SPP.P - SI.P) / SI.R;
    SPP.ambient = SI.ambient;
    SPP.dif = SI.dif;
    SPP.highlight = SI.highlight;
    SPP.K_s = SI.Ks;
    SPP.ior = SI.ior;
    SPP.name = i;

    float texturePeriod = 5.0;
    vec2 uvTex = texturePeriod * TexMap_Sphere(SI.L.N, SPP.N);
    vec3 N_buf = 2.0 * textureLod(u_tex2, uvTex, 2.0).xyz - vec3(1.0);
    vec3 N_Sh = N_buf.x * SI.L.N[0] + N_buf.y * SI.L.N[1] + N_buf.z * SI.L.N[2];
    float Nscale[4] = float[4](1.0, 0.25, 1.0, 10.1);

    SPP.N = normalize(Nscale[0] * SPP.N + Nscale[1] * N_Sh);
    SPP.ambient = (Nscale[2] * SPP.ambient + Nscale[3] * textureLod(u_tex3, uvTex, 2.0)) / (Nscale[2] + Nscale[3]);
    SPP.dif = SPP.ambient;
    return SPP;
}

void main() {
    vec2 resolution = safeResolution();
    vec2 fragCoord = uv * resolution;
    vec2 normMouse = u_mouse / resolution;
    vec2 fragUv = fragCoord / resolution;

    HemiSphere HS = IglooSampleCreate(3, fragUv, 0.01 * normMouse.y);
    vec4 col = vec4(0.0);
    vec4 BG;
    vec4 dif0 = vec4(0.1, 0.9, 0.1, 0.0);
    vec4 dif1 = vec4(0.9, 0.1, 0.1, 0.0);
    vec4 ambient0 = dif0;
    vec4 ambient1 = dif1;
    vec4 highlight0 = vec4(1.0);
    vec4 ambient;
    vec4 dif;
    vec4 highlight;
    float K_s;
    float Ks0 = 0.01;
    float Ks1 = 0.99;
    LocalCoord L1 = TimeBasedCoord(0.5);
    Ray RI;

    vec3 N;
    vec3 P_E = vec3(resolution.x / 2.0, resolution.y / 2.0, resolution.x / 2.0);
    vec3 P_P = vec3(fragCoord.x, fragCoord.y, 0.0);
    vec3 P_L = vec3(u_mouse.x, u_mouse.y, resolution.x / 3.0);
    vec3 origin = vec3(resolution.x / 2.2, resolution.y / 2.0, -resolution.x / 15.0);

    float theta;
    float d;
    float R0;

    int M = 6;
    float totalturn = float(M);
    float thetachange = 2.0 * pi / totalturn;
    float psi = 0.0;
    R0 = resolution.x / 2.0;
    d = 1.5 * R0;
    float Rscale = 0.75;
    float thetascale = 0.9;
    float dscale = 0.8;
    float z0 = -2.0;

    Sphere[20] S;
    S[0].R = R0;
    theta = thetachange;
    vec3 offset = vec3(cos(psi), sin(psi), z0);
    S[0].P = origin + d * offset;
    S[0].ambient = ambient0;
    S[0].dif = dif0;
    S[0].highlight = highlight0;
    S[0].Ks = Ks0;
    S[0].ior = 1.6;
    S[0].L = TimeBasedCoord(0.0);

    for (int i = 1; i < M; i += 1) {
        float j = float(i);
        float t = (j * 2.37) / float(M);
        t = t - floor(t);
        offset = vec3(cos(theta + psi), sin(theta + psi), z0);
        thetachange = thetascale * thetachange;
        theta += thetachange;
        S[i].R = Rscale * S[i - 1].R;
        d = dscale * d;
        S[i].P = origin + d * offset;
        S[i].ambient = ambient0 * (1.0 - t) + ambient1 * t;
        S[i].dif = dif0 * (1.0 - t) + dif1 * t;
        S[i].highlight = highlight0;
        float t2 = float(i) - 2.0 * floor(float(i) / 2.0);
        S[i].Ks = Ks0 * (1.0 - t2) + Ks1 * t2;
        S[i].ior = 1.6;
        S[i].L = TimeBasedCoord(0.0);
    }

    vec3 N_PE = normalize(P_P - P_E);
    float t;
    float mint = 10000.0;
    vec3 P_H = vec3(0.0);
    vec4 illum;
    vec4 spec;
    float weight = 1.0;
    float ior = pow(2.0, weight);
    int object = M;

    vec2 uvTex = TexMap_Sphere(L1.N, N_PE);
    BG = texture(u_tex0, uvTex);
    col = BG;

    RI.N = N_PE;
    RI.P = P_E;
    for (int i = 0; i < M; i += 1) {
        t = ComputeIntersection(RI, S[i]);
        if (t < mint && t > 0.0) {
            mint = t;
            Shading_Point_Properties SPP = Compute_Shading_Properties(RI, S[i], t, i);
            P_H = SPP.P;
            N = SPP.N;
            ambient = SPP.ambient;
            dif = SPP.dif;
            highlight = SPP.highlight;
            K_s = SPP.K_s;
            object = SPP.name;
        }
    }

    if (object < M) {
        vec4 totalillum = vec4(0.0, 0.0, 0.0, 1.0);
        float totalweight = 0.0;

        for (int j = 0; j < HS.M; j += 1) {
            vec3 N_tex = compute_HS_Orientation(N, j, fragUv, HS);
            uvTex = TexMap_Sphere(L1.N, N_tex);

            BG = textureLod(u_tex0, uvTex, 5.0);
            float sampleWeight = dot(N_tex, N) + 0.25;
            totalweight += sampleWeight;

            illum = BG;
            illum = powcolor(BG, vec4(0.55), vec4(2.0));

            float softness = 1.0 + 1.75 * normMouse.x;
            RI.N = N_tex;
            RI.P = P_H;

            for (int i = 0; i < M; i += 1) {
                t = ComputeSoftShadow(RI, S[i], softness);
                if (t > 0.0) {
                    illum = illum * S[i].ambient * t;
                }
            }

            mint = 1000.0;
            Shading_Point_Properties SPP;
            SPP.P = P_H;
            SPP.N = N;
            SPP.ambient = ambient;
            SPP.dif = dif;
            SPP.highlight = highlight;
            SPP.K_s = K_s;
            SPP.ior = ior;
            SPP.name = object;

            for (int i = 0; i < M; i += 1) {
                t = ComputeIntersection(RI, S[i]);
                if (t < mint && t > 0.0) {
                    mint = t;
                    SPP = Compute_Shading_Properties(RI, S[i], t, i);
                }
            }

            Refraction CausticObj = ComputeRefractionComponents(SPP.N, RI.N, SPP.ior);
            vec4 caustic = ComputeRefractionColor(L1.N, CausticObj, 2.0);
            caustic = powcolor(caustic, vec4(0.55), vec4(9.0));
            illum = (1.0 - SPP.K_s) * illum + SPP.K_s * caustic;

            totalillum += illum * sampleWeight;
        }

        ambient = ambient * totalillum / max(totalweight, 0.0001);

        Refraction Obj = ComputeRefractionComponents(N, N_PE, ior);
        spec = ComputeRefractionColor(L1.N, Obj, 2.0);
        spec = powcolor(spec, vec4(0.55), vec4(4.0));

        vec3 L = normalize(P_L - P_H);
        float costeta = 0.1 * dot(N, L);
        if (costeta < 0.0) {
            costeta = 0.0;
        }

        col = ambient * (1.0 - costeta) + dif * costeta;
        col = K_s * spec + col * (1.0 - K_s);
    }

    out_color = vec4(col.rgb, 1.0);
}
