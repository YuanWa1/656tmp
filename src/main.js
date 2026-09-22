import './style.css'

import vertexShaderSource from "./shader/basic.vert?raw";
import BlinnPhongShaderSource from "./shader/BlinnPhong.frag?raw";

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.error(gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return undefined;
}

function createProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  console.error(gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return undefined;
}

function createQuad(gl, program) {
  const loc = gl.getAttribLocation(program, "a_position");
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  -1, 1,  1, 1,
    -1, -1,   1, -1, 1, 1,
  ]), gl.STATIC_DRAW);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vbo };
}

// Albedo is color data -> SRGB8_ALPHA8 so sampling returns linear values.
// Normal map is vector data -> plain RGBA8, never sRGB-decoded.
// Both get trilinear mipmaps; the shader renormalizes the filtered normal.
function createTexture(gl, image, unit, isColor) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const internalFormat = isColor ? gl.SRGB8_ALPHA8 : gl.RGBA8;
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

async function loadBitmap(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  // premultiplyAlpha/colorSpaceConversion "none": keep the normal map bytes untouched.
  return await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

function bindControls() {
  const params = {};
  const sliders = ["lightHeight", "ks", "shininess", "ambient"];
  for (const id of sliders) {
    const el = document.getElementById(id);
    const out = document.getElementById(`${id}-out`);
    const update = () => {
      params[id] = parseFloat(el.value);
      if (out) out.textContent = el.value;
    };
    el.addEventListener("input", update);
    update();
  }
  for (const id of ["orbit", "specular", "flipGreen"]) {
    const el = document.getElementById(id);
    const update = () => { params[id] = el.checked; };
    el.addEventListener("change", update);
    update();
  }
  const view = document.getElementById("view");
  const updateView = () => { params.view = parseInt(view.value, 10); };
  view.addEventListener("change", updateView);
  updateView();
  return params;
}

async function main() {
  const canvas = document.querySelector("#glcanvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    canvas.replaceWith(Object.assign(document.createElement("p"), { textContent: "WebGL2 is not available in this browser." }));
    return;
  }

  const program = createProgram(
    gl,
    createShader(gl, gl.VERTEX_SHADER, vertexShaderSource),
    createShader(gl, gl.FRAGMENT_SHADER, BlinnPhongShaderSource),
  );
  const { vao } = createQuad(gl, program);

  const u = {};
  for (const name of ["u_resolution", "u_mouse", "u_lightHeight", "u_shininess", "u_ks",
                      "u_ambient", "u_flipGreen", "u_specular", "u_view", "u_base", "u_normal"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  const basePath = import.meta.env.BASE_URL;
  const [baseBitmap, normalBitmap] = await Promise.all([
    loadBitmap(`${basePath}pics/base.png`),
    loadBitmap(`${basePath}pics/normal.png`),
  ]);
  createTexture(gl, baseBitmap, 0, true);
  createTexture(gl, normalBitmap, 1, false);

  // Match the canvas to the image aspect so the surface is not stretched.
  const aspect = normalBitmap.width / normalBitmap.height;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 640;
    canvas.style.aspectRatio = `${aspect}`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * dpr / aspect);
  }
  resize();
  window.addEventListener("resize", resize);

  const params = bindControls();

  // Light position in drawing-buffer pixels, origin bottom-left. Start centered.
  let light = { x: canvas.width * 0.5, y: canvas.height * 0.5 };
  canvas.addEventListener("pointermove", (e) => {
    if (params.orbit) return;
    const rect = canvas.getBoundingClientRect();
    light.x = (e.clientX - rect.left) * (canvas.width / rect.width);
    light.y = (rect.height - (e.clientY - rect.top)) * (canvas.height / rect.height);
  });

  gl.useProgram(program);
  gl.uniform1i(u.u_base, 0);
  gl.uniform1i(u.u_normal, 1);

  function frame(timeMs) {
    if (params.orbit) {
      const t = timeMs * 0.0008;
      light.x = canvas.width  * (0.5 + 0.38 * Math.cos(t));
      light.y = canvas.height * (0.5 + 0.38 * Math.sin(t));
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.uniform2f(u.u_resolution, canvas.width, canvas.height);
    gl.uniform2f(u.u_mouse, light.x, light.y);
    gl.uniform1f(u.u_lightHeight, params.lightHeight);
    gl.uniform1f(u.u_shininess, params.shininess);
    gl.uniform1f(u.u_ks, params.ks);
    gl.uniform1f(u.u_ambient, params.ambient);
    gl.uniform1i(u.u_flipGreen, params.flipGreen ? 1 : 0);
    gl.uniform1i(u.u_specular, params.specular ? 1 : 0);
    gl.uniform1i(u.u_view, params.view);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
