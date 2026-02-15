#version 300 es
 
// an attribute is an input (in) to a vertex shader.
// It will receive data from a buffer
layout(location = 0) in vec4 a_position;
 
out vec2 uv;

// all shaders have a main function
void main() {
 
  // gl_Position is a special variable a vertex shader
  // is responsible for setting
  uv = a_position.xy * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  gl_Position = a_position;
}