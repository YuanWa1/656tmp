#version 300 es
precision highp float;

in vec2 uv;

uniform sampler2D u_accumulation;

out vec4 outColor;

void main() {
  vec3 color = texture(u_accumulation, uv).rgb;

  color = color / (color + vec3(1.0));
  color = pow(color, vec3(1.0 / 2.2));

  outColor = vec4(color, 1.0);
}
