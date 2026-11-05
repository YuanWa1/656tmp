import "./style.css";

import vertexShaderSource from "./shader/basic.vert?raw";
import envMapShaderSource from "./shader/env_map.frag?raw";

import { render } from "./renderer.js";
import { compileShader, createTexture2D, linkProgram } from "./webgl-utils.js";
import { loadEnvironment } from "./hdr-loader.js";

const BASE = import.meta.env.BASE_URL;
// CC0 panorama from Poly Haven (via the three.js examples).
const ENV_URL = `${BASE}envmap/san_giuseppe_bridge_2k.hdr`;
const ENV_EXPOSURE = 0.75;

function initGL() {
  const canvas = document.querySelector("#glcanvas");
  if (!canvas) {
    throw new Error("Canvas element #glcanvas was not found.");
  }

  const gl = canvas.getContext("webgl2");
  if (!gl) {
    throw new Error("WebGL2 is not supported in this browser.");
  }

  return { canvas, gl };
}

function createFullscreenQuad(gl, program) {
  const positionLocation = gl.getAttribLocation(program, "a_position");
  const positions = new Float32Array([
    -1, -1,
    -1, 1,
    1, 1,
    -1, -1,
    1, -1,
    1, 1,
  ]);

  const vbo = gl.createBuffer();
  const vao = gl.createVertexArray();

  if (!vbo || !vao) {
    throw new Error("Failed to create fullscreen quad geometry.");
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return { vao, vbo, count: 6 };
}

async function loadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  // Flip so row 0 of the PNG (top) lands at v = 1, matching uv in basic.vert.
  // No premultiply / color conversion: normal maps store data, not color.
  return createImageBitmap(await response.blob(), {
    imageOrientation: "flipY",
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
}

// Baked by scripts/bake_normal_map.py. Both maps are linear data.
async function loadSceneMaps(gl) {
  const [normal, objects] = await Promise.all(
    ["normal.png", "objects.png"].map((name) => loadImage(`${BASE}normalmap/${name}`)),
  );
  const options = { generateMipmaps: false, isLinear: true };
  return {
    normal: createTexture2D(gl, normal, options),
    objects: createTexture2D(gl, objects, options),
  };
}

function bindControls() {
  const read = (id) => document.getElementById(id);
  const params = { roughness: 0.5, autoRotate: false, showNormals: false };

  const roughness = read("env-roughness");
  const roughnessOut = read("env-roughness-out");
  const syncRoughness = () => {
    params.roughness = Number(roughness.value);
    roughnessOut.textContent = params.roughness.toFixed(2);
  };
  roughness.addEventListener("input", syncRoughness);
  syncRoughness();

  for (const [id, key] of [["env-rotate", "autoRotate"], ["env-normals", "showNormals"]]) {
    const input = read(id);
    input.addEventListener("change", () => { params[key] = input.checked; });
  }
  return params;
}

// Column-major rotation (world -> environment): yaw about +Y, then pitch about +X.
function envRotationMatrix(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Ry(yaw) * Rx(pitch)
  return new Float32Array([
    cy, 0, -sy,
    sy * sp, cp, cy * sp,
    sy * cp, -sp, cy * cp,
  ]);
}

function resizeCanvasToDisplaySize(canvas) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function main() {
  const { canvas, gl } = initGL();
  // Needed to generate mipmaps for the RGBA16F environment texture.
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float is required.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, envMapShaderSource);
  const material = linkProgram(gl, vertexShader, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  const [maps, environment] = await Promise.all([loadSceneMaps(gl), loadEnvironment(gl, ENV_URL)]);
  const params = bindControls();
  const geometry = createFullscreenQuad(gl, material.program);

  // Environment orientation: target follows the mouse, current eases toward it.
  const target = { yaw: 0, pitch: 0 };
  const current = { yaw: 0, pitch: 0 };

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const u = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const v = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    target.yaw = (u - 0.5) * 2 * Math.PI;
    target.pitch = (v - 0.5) * 0.7;
  });

  let previousTime = performance.now();

  function frame(now) {
    // Bound elapsed time after a stalled/background frame to prevent large jumps.
    const deltaSeconds = Math.min(Math.max((now - previousTime) * 0.001, 0), 0.05);
    previousTime = now;
    resizeCanvasToDisplaySize(canvas);

    if (params.autoRotate) target.yaw += deltaSeconds * 0.35;
    // Exponential smoothing keeps fast mouse moves from jumping.
    const k = 1 - Math.exp(-deltaSeconds * 10);
    current.yaw += (target.yaw - current.yaw) * k;
    current.pitch += (target.pitch - current.pitch) * k;

    render(
      gl,
      geometry,
      material,
      {
        u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
        u_normalMap: { type: "1i", value: 0 },
        u_objects: { type: "1i", value: 1 },
        u_env: { type: "1i", value: 2 },
        u_irradiance: { type: "1i", value: 3 },
        u_envWidth: { type: "1f", value: environment.width },
        u_envMaxLod: { type: "1f", value: environment.maxLod },
        u_envRotation: { type: "mat3", value: envRotationMatrix(current.yaw, current.pitch) },
        u_exposure: { type: "1f", value: ENV_EXPOSURE },
        u_roughness: { type: "1f", value: params.roughness },
        u_showNormals: { type: "1i", value: params.showNormals ? 1 : 0 },
      },
      [
        { handle: maps.normal },
        { handle: maps.objects },
        { handle: environment.radiance },
        { handle: environment.irradiance },
      ],
    );

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
});
