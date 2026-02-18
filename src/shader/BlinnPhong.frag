#version 300 es
 
// fragment shaders don't have a default precision so we need
// to pick one. highp is a good default. It means "high precision"
precision highp float;
precision highp sampler2D;
 
in vec2 uv;

uniform vec2 u_resolution;
uniform vec2 u_mouse;

uniform sampler2D u_base;
uniform sampler2D u_normal;
uniform sampler2D u_ambient;

// we need to declare an output for the fragment shader
out vec4 outColor;
 
void main() {
    vec3 Kd,Ka,Ks;
    vec3 Ia,Is,Id;

    vec3 albedo = texture(u_base, uv).rgb;
    vec3 nTex   = texture(u_normal, uv).rgb;
    vec3 ambient = texture(u_ambient, uv).rgb;

    //Initial variable
    Id = vec3(1);
    Is = Id;
    Ia = 0.05 * Id;
    // Ia = ambient;


    Ks = vec3(0.05);
    Kd = albedo;
    Ka = albedo;

    vec3 N = normalize(nTex * 2.0 - 1.0);
    //N.y = -N.y;

    //Light
    vec2 mouse_position = vec2(u_mouse.x, u_mouse.y) / u_resolution.xy;
  
    vec3 L = normalize(vec3(mouse_position,0.2) - vec3(uv,0.0));

    //View
    vec3 V = vec3(0.0,0.0,1.0);


    //diffuse
    float diff = max(dot(N,L),0.0);

    //spec
    vec3 H = normalize(L + V);

    float spec = pow(max(dot(N,H),0.0),8.0);

    //
    vec3 am = Ka * Ia;
    vec3 dif = diff * Kd * Id;
    vec3 spc = spec * Ks * Is;

    //From rgb to srgb
    vec3 linearColor = am + dif + spc;
    vec3 srgb = pow(clamp(linearColor, 0.0, 1.0), vec3(1.0/2.2));

    outColor = vec4(srgb, 1.0);
}