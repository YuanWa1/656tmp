#version 300 es

precision highp float;
precision highp sampler2D;

in vec2 uv;

out vec4 out_color;

uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float n1;
uniform float n2;

uniform sampler2D u_base;


void main() {
  float aspect = u_resolution.x / u_resolution.y;

  vec2 p = uv * 2.0 - 1.0;

  p.x *= aspect;

  //Center of the sphere
  vec2 c = (u_mouse.xy / u_resolution.xy) * 2.0 - 1.0;
  c.x *= aspect;

  //radius of the sphere
  float r = 0.2;

  //compute the N
   vec2 q = (p-c) / r;

  float rr = dot(q, q);

  if (rr > 1.0) {
    vec3 bg = texture(u_base, uv).rgb;
    bg= pow(clamp(bg, 0.0, 1.0), vec3(1.0/2.2));
    out_color = vec4(bg, 1.0);
    return;
  }

  float z = sqrt(1.0 - rr);
  vec3 N = vec3(q, z);

  // //Light
  // vec2 mouse_position = (vec2(u_mouse.x, u_mouse.y) / u_resolution.xy)*2.0-1.0;

  // vec3 L = normalize(vec3(mouse_position,1.0) - vec3(p,0.0));

  //View
  vec3 V = vec3(0.0,0.0,5.0);

  //First Intersection
  vec3 first_inter = vec3(p,r*z);

  //In
  vec3 I = normalize(first_inter - V); 
  // I = -V;

  float F0 = (n1 - n2)/(n1 + n2) * (n1 - n2)/(n1 + n2);
  float F = F0 + (1.0-F0) * pow( max(1.0 - dot(N,-I), 0.0), 5.0);

  //Reflection
  vec3 R = reflect(I,N);

  vec3 skyColor = vec3(0.6, 0.8, 1.0);
  vec3 groundColor = vec3(0.1, 0.05, 0.02);
  
  float envMix = R.y * 0.5 + 0.5; 
  vec3 reflectColor = mix(groundColor, skyColor, envMix);

  vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0)); 
  float sunSpec = pow(max(dot(R, lightDir), 0.0), 64.0); 
  reflectColor += vec3(1.0) * sunSpec;

  //After first refraction
  vec3 T = refract(I,N,n1/n2);

  if (length(T) < 0.001) {
        out_color = vec4(reflectColor, 1.0);
        return;
    }

  //second intersction
  vec3 C3 = vec3(c, 0.0);
  vec3 P  = first_inter - C3;
  vec3 second_inter = first_inter - 2.0 * dot(P, T) * T;

  //Computer second N
  vec3 N2 = normalize(-(second_inter - C3));

  float F0_sec = (n2 - n1)/(n1 + n2) * (n2 - n1)/(n1 + n2);
  float F_sec = F0_sec + (1.0-F0_sec) * pow( max(1.0 - dot(N2,-T), 0.0), 5.0);

  //After second refraction
  vec3 T2 = refract(T,N2,n2/n1);

  if (length(T2) < 0.001) {
      out_color = vec4(0.0, 0.0, 0.0, 1.0); 
      return;
  }

  // This is mathmatical way of calculating the uv
  // float z_bg = -0.21;

  // float t_bg = (z_bg - second_inter.z) / T2.z;

  // if (t_bg < 0.0) {
  //       out_color = vec4(0.0, 0.0, 0.0, 1.0);
  //       return;
  //   }

  //vec2 Q = second_inter.xy + t_bg*T2.xy;

  float distance_factor = 0.02;
  vec2 Q = second_inter.xy + T2.xy * distance_factor;
  Q.x /= aspect;
  Q = Q*0.5+0.5;

  // Q = clamp(Q, 0.0, 1.0);
  
  vec3 bgColor = texture(u_base,Q).rgb;

  bgColor = bgColor*(1.0 -F_sec);

  vec3 finalColor = mix(bgColor, reflectColor, F);

  finalColor= pow(clamp(finalColor, 0.0, 1.0), vec3(1.0/2.2));

  out_color = vec4(finalColor,1.0);
}