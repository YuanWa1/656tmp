import './style.css'

import vertexShaderSource from "./shader/basic.vert?raw";
import BlinnPhongShaderSource from "./shader/BlinnPhong.frag?raw";

// Shared rendering utilities restored from main's reusable WebGL framework.
import { render } from './renderer.js';
import { compileShader, linkProgram } from './webgl-utils.js';
import { createTextureManager, loadBitmap, setupTextureSlotUI } from './texture-manager.js';

// Create the screen-space geometry used by the normal-map shader.
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
  return { vao, vbo, count: 6 };
}

// Bind the existing lighting controls independently of texture slot uploads.
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

// Initialize the normal-map demo on top of the shared texture/render framework.
async function main() {
  const canvas = document.querySelector("#glcanvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    canvas.replaceWith(Object.assign(document.createElement("p"), { textContent: "WebGL2 is not available in this browser." }));
    return;
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, BlinnPhongShaderSource);
  const material = linkProgram(gl, vertexShader, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  const geometry = createQuad(gl, material.program);

  const basePath = import.meta.env.BASE_URL;
  const [baseBitmap, normalBitmap] = await Promise.all([
    loadBitmap(`${basePath}pics/base.png`),
    loadBitmap(`${basePath}pics/normal.png`),
  ]);
  let aspect = normalBitmap.width / normalBitmap.height;
  // The normal map defines the surface dimensions, including after a user upload.
  const textureManager = createTextureManager(gl, (index, slot) => {
    if (index === 1) {
      aspect = slot.bitmap.width / slot.bitmap.height;
      resize();
    }
  });
  textureManager.setSlotBitmap(0, baseBitmap, false);
  textureManager.setSlotBitmap(1, normalBitmap, true);
  setupTextureSlotUI(textureManager);

  // Match the canvas to the image aspect so the surface is not stretched.
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

  // Normalized bottom-left coordinates keep the light fixed when an upload resizes the canvas.
  const light = { x: 0.5, y: 0.5 };
  canvas.addEventListener("pointermove", (e) => {
    if (params.orbit) return;
    const rect = canvas.getBoundingClientRect();
    light.x = (e.clientX - rect.left) / rect.width;
    light.y = 1 - (e.clientY - rect.top) / rect.height;
  });

  function frame(timeMs) {
    if (params.orbit) {
      const t = timeMs * 0.0008;
      light.x = 0.5 + 0.38 * Math.cos(t);
      light.y = 0.5 + 0.38 * Math.sin(t);
    }

    // Keep semantic samplers and generic slot samplers available to future shaders.
    const uniforms = {
      u_resolution: { type: '2f', value: [canvas.width, canvas.height] },
      u_mouse: { type: '2f', value: [light.x * canvas.width, light.y * canvas.height] },
      u_lightHeight: { type: '1f', value: params.lightHeight },
      u_shininess: { type: '1f', value: params.shininess },
      u_ks: { type: '1f', value: params.ks },
      u_ambient: { type: '1f', value: params.ambient },
      u_flipGreen: { type: '1i', value: params.flipGreen ? 1 : 0 },
      u_specular: { type: '1i', value: params.specular ? 1 : 0 },
      u_view: { type: '1i', value: params.view },
      u_base: { type: '1i', value: 0 },
      u_normal: { type: '1i', value: 1 },
    };
    textureManager.slots.forEach((_, index) => {
      uniforms['u_tex' + index] = { type: '1i', value: index };
    });
    render(gl, geometry, material, uniforms, textureManager.slots);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
  document.getElementById('app-status').textContent = error.message;
});
