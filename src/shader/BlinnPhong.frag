#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 uv;

uniform vec2  u_resolution;
uniform vec2  u_mouse;        // light position in canvas pixels (origin bottom-left)
uniform float u_lightHeight;  // light z above the plane, in uv units
uniform float u_shininess;    // Blinn-Phong exponent
uniform float u_ks;           // specular strength
uniform float u_ambient;      // ambient strength
uniform bool  u_flipGreen;    // normal map stores +Y pointing down the image (DirectX style)
uniform bool  u_specular;     // specular term on/off
uniform int   u_view;         // 0 = shaded, 1 = diffuse term only, 2 = decoded normals

uniform sampler2D u_base;
uniform sampler2D u_normal;

out vec4 outColor;

void main() {
    // Albedo is uploaded as SRGB8_ALPHA8, so the hardware already returns linear values.
    vec3 albedo = texture(u_base, uv).rgb;

    // Normal map is uploaded as RGBA8 (raw data, no sRGB decode).
    // Decode [0,1] -> [-1,1], then renormalize: filtering/mipmapping shortens the vector.
    vec3 N = texture(u_normal, uv).rgb * 2.0 - 1.0;
    if (u_flipGreen) N.y = -N.y;
    N = normalize(N);

    // Point light above the plane at (mouse, height); surface point is (uv, 0).
    // Work in aspect-corrected units (height = 1) so x and y distances match on screen.
    vec2 aspect  = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 lightXY = (u_mouse / u_resolution) * aspect;
    vec2 surfXY  = uv * aspect;
    vec3 L = normalize(vec3(lightXY - surfXY, u_lightHeight));

    // Fixed orthographic view straight down the z axis.
    vec3 V = vec3(0.0, 0.0, 1.0);

    float NdotL = dot(N, L);
    float diff = max(NdotL, 0.0);

    // Blinn-Phong specular. Gated by N.L so a surface facing away from the light
    // cannot pick up a highlight when H happens to align with N at grazing angles.
    float spec = 0.0;
    if (u_specular && NdotL > 0.0) {
        vec3 H = normalize(L + V);
        spec = pow(max(dot(N, H), 0.0), u_shininess);
        // Soft fade near the terminator instead of a hard cut.
        spec *= smoothstep(0.0, 0.15, NdotL);
    }

    vec3 linearColor;
    if (u_view == 2) {
        outColor = vec4(N * 0.5 + 0.5, 1.0);   // visualize decoded normal
        return;
    } else if (u_view == 1) {
        linearColor = vec3(diff);
    } else {
        vec3 ambient  = u_ambient * albedo;
        vec3 diffuse  = diff * albedo;
        vec3 specular = spec * vec3(u_ks);
        linearColor = ambient + diffuse + specular;
    }

    // Lighting is done in linear space; encode to sRGB for display.
    vec3 srgb = pow(clamp(linearColor, 0.0, 1.0), vec3(1.0 / 2.2));
    outColor = vec4(srgb, 1.0);
}
