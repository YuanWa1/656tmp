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


float getZ(vec2 uv1){
    return texture(u_tex0,uv1).r - 1.0;
}

void main() {
    vec2 mouse_position = (vec2(u_mouse.x, u_mouse.y) / u_resolution.xy)*2.0-1.0;

    if(texture(u_tex0, uv).r < 0.01){
        out_color = vec4(0);
        return;
    }

    vec3 currentPos = vec3(uv*2.0-1.0, getZ(uv));

    vec3 LightPos = vec3(mouse_position, -1.0); 

    float d = 0.05;
    float a = d / 10.0;

    vec3 normals = normalize(texture(u_tex1,uv).rgb * 2.0 - 1.0);

    currentPos = currentPos - d * normals;

    vec3 lightDir = normalize(LightPos - currentPos);
    currentPos = currentPos + a * 0.5 * lightDir;

    //int K = int(ceil(length(LightPos - currentPos)/a));

    int K = 100;

    vec3 stepVector = a * lightDir;

    float r = d;

    for(int i = 0; i < K; i++) {
        currentPos = currentPos + stepVector;
        if(currentPos.z < getZ(currentPos.xy*0.5+0.5) && currentPos.z > - 0.8){
            r = r + length(stepVector);
        }else if(currentPos.z < -0.8){
            break;
        }
    }
    float t = d / r;
    // t = pow(t, 1.2);
    t=clamp(t,0.0,1.0);

    vec3 Albedo = vec3(0.75, 0.88, 0.75);
    vec3 LightColor = vec3(1.0, 0.98, 0.95);
    vec3 ScatterColor = vec3(0.35, 0.85, 0.25);

    float NdotL = max(0.0, dot(normals, lightDir));

    vec3 surfaceLight = Albedo * LightColor * t;

    float sssIntensity = max(0.0, t - NdotL); 

    sssIntensity = smoothstep(0.0, 0.4, sssIntensity);
    vec3 scatterLight = ScatterColor * LightColor * sssIntensity;

    vec3 ambientLight = Albedo * 0.01;

    vec3 FinalColor = surfaceLight * 0.6 + scatterLight + ambientLight;
    out_color = vec4(FinalColor, 1.0);
}