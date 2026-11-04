import "./style.css";

import vertexShaderSource from "./shader/basic.vert?raw";
import fragmentShaderSource from "./shader/path_trace.frag?raw";
import displayShaderSource from "./shader/display.frag?raw";
import normalMapShaderSource from "./shader/normal_map.frag?raw";
import envMapShaderSource from "./shader/env_map.frag?raw";

import { render } from "./renderer.js";
import { compileShader, createTexture2D, linkProgram } from "./webgl-utils.js";
import { loadHdrTexture } from "./hdr-loader.js";

const CAMERA_Z_SCROLL_SPEED = 0.002;
const CAMERA_Z_MIN = -2.5;
const CAMERA_Z_MAX = 2.0;
const CAMERA_MOVE_SPEED = 1.2;

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

  return {
    vao,
    vbo,
    count: 6,
  };
}

function createAccumulationTarget(gl, width, height) {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();

  if (!texture || !framebuffer) {
    throw new Error("Failed to create progressive accumulation target.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA16F,
    width,
    height,
    0,
    gl.RGBA,
    gl.HALF_FLOAT,
    null,
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error("Progressive accumulation framebuffer is incomplete.");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { texture, framebuffer, width, height };
}

function createAccumulationTargets(gl, width, height) {
  return [
    createAccumulationTarget(gl, width, height),
    createAccumulationTarget(gl, width, height),
  ];
}

function deleteAccumulationTargets(gl, targets) {
  for (const target of targets) {
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);
  }
}

const NORMAL_MAP_DIR = `${import.meta.env.BASE_URL}normalmap/`;

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

// Normal maps and masks are linear data; albedo is sRGB color.
async function loadNormalMapScene(gl) {
  const [normal, normalBack, albedo, mask] = await Promise.all(
    ["normal.png", "normal_back.png", "albedo.png", "mask.png"].map((name) =>
      loadImage(`${NORMAL_MAP_DIR}${name}`),
    ),
  );
  const options = { generateMipmaps: false };
  return {
    normal: createTexture2D(gl, normal, { ...options, isLinear: true }),
    normalBack: createTexture2D(gl, normalBack, { ...options, isLinear: true }),
    albedo: createTexture2D(gl, albedo, { ...options, isLinear: false }),
    mask: createTexture2D(gl, mask, { ...options, isLinear: true }),
  };
}

function bindNormalMapControls() {
  const read = (id) => document.getElementById(id);
  const sliders = {
    lightHeight: ["nm-height", 2],
    colorShift: ["nm-shift", 2],
  };
  const params = { showNormals: false, orbit: false };

  for (const [key, [id, digits]] of Object.entries(sliders)) {
    const input = read(id);
    const output = read(`${id}-out`);
    const sync = () => {
      params[key] = Number(input.value);
      if (output) output.textContent = params[key].toFixed(digits);
    };
    input.addEventListener("input", sync);
    sync();
  }

  const normals = read("nm-normals");
  normals.addEventListener("change", () => { params.showNormals = normals.checked; });

  const orbit = read("nm-orbit");
  orbit.addEventListener("change", () => { params.orbit = orbit.checked; });

  return params;
}

// CC0 panoramas from Poly Haven (via the three.js examples).
const ENVIRONMENTS = {
  san_giuseppe_bridge: { file: "san_giuseppe_bridge_2k.hdr", exposure: 1.0 },
  venice_sunset: { file: "venice_sunset_1k.hdr", exposure: 0.8 },
  royal_esplanade: { file: "royal_esplanade_1k.hdr", exposure: 0.6 },
};
const ENV_DIR = `${import.meta.env.BASE_URL}envmap/`;

function bindEnvMapControls() {
  const read = (id) => document.getElementById(id);
  const params = { env: "san_giuseppe_bridge", mirror: false, autoRotate: false, showNormals: false };
  const env = read("env-select");
  env.addEventListener("change", () => { params.env = env.value; });
  for (const [id, key] of [["env-mirror", "mirror"], ["env-rotate", "autoRotate"], ["env-normals", "showNormals"]]) {
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
    return true;
  }

  return false;
}

async function main() {
  const { canvas, gl } = initGL();
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float is required for progressive rendering.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const displayFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, displayShaderSource);
  const normalMapFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, normalMapShaderSource);
  const material = linkProgram(gl, vertexShader, fragmentShader);
  const displayMaterial = linkProgram(gl, vertexShader, displayFragmentShader);
  const normalMapMaterial = linkProgram(gl, vertexShader, normalMapFragmentShader);
  const envMapFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, envMapShaderSource);
  const envMapMaterial = linkProgram(gl, vertexShader, envMapFragmentShader);
  gl.deleteShader(envMapFragmentShader);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.deleteShader(displayFragmentShader);
  gl.deleteShader(normalMapFragmentShader);

  const normalMapTextures = await loadNormalMapScene(gl);
  const normalMapParams = bindNormalMapControls();
  const envParams = bindEnvMapControls();
  // HDRs load on first use; the default one before the first frame.
  const envTextures = {};
  const envLoading = {};
  function requestEnv(name) {
    if (!envLoading[name]) {
      envLoading[name] = loadHdrTexture(gl, `${ENV_DIR}${ENVIRONMENTS[name].file}`)
        .then((texture) => { envTextures[name] = texture; })
        .catch((error) => console.error(error));
    }
    return envLoading[name];
  }
  await requestEnv(envParams.env);

  const geometry = createFullscreenQuad(gl, material.program);

  let mouseX = canvas.width * 0.5;
  let mouseY = canvas.height * 0.5;
  let frameIndex = 0;
  let readTargetIndex = 0;
  let accumulationTargets = [];
  let cameraZOffset = 0;
  const cameraOffset = [0, 0, 0];
  const pressedKeys = new Set();
  const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"]);
  let previousFrameTime = performance.now();
  const startTime = performance.now();

  // "env": fixed view, the mouse rotates the environment map.
  // "normal": fixed view, the mouse moves the light.
  // "path": progressive path tracer, the mouse and keys move the camera.
  let mode = "env";
  // Environment orientation: target follows the mouse, current eases toward it.
  const envTarget = { yaw: 0, pitch: 0 };
  const envCurrent = { yaw: 0, pitch: 0 };
  // Light position in uv space (origin bottom-left), upper left by default.
  const lightUv = [0.3, 0.75];

  function setMode(nextMode) {
    mode = nextMode;
    for (const element of document.querySelectorAll("[data-mode]")) {
      element.hidden = element.dataset.mode !== mode;
      // Only the visible mode's demo video plays.
      for (const video of element.querySelectorAll("video")) {
        if (element.hidden) video.pause();
        else video.play().catch(() => {});
      }
    }
    pressedKeys.clear();
    resetAccumulation();
  }

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) setMode(radio.value);
    });
  }

  function resetAccumulation() {
    frameIndex = 0;
    readTargetIndex = 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function setMousePosition(event) {
    const rect = canvas.getBoundingClientRect();
    if (mode === "env") {
      const u = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const v = clamp((event.clientY - rect.top) / rect.height, 0, 1);
      envTarget.yaw = (u - 0.5) * 2 * Math.PI;
      envTarget.pitch = (v - 0.5) * 0.7;
      return;
    }
    if (mode === "normal") {
      lightUv[0] = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      lightUv[1] = clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1);
      return;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const nextMouseX = (event.clientX - rect.left) * scaleX;
    const nextMouseY = canvas.height - (event.clientY - rect.top) * scaleY - 1;

    if (nextMouseX !== mouseX || nextMouseY !== mouseY) {
      mouseX = nextMouseX;
      mouseY = nextMouseY;
      resetAccumulation();
    }
  }

  canvas.addEventListener("mousemove", setMousePosition);
  // Scope shortcuts to the canvas so typing or operating other page controls
  // does not move the camera. Clear held keys when focus leaves the viewer.
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Path tracer. WASD: move horizontally. Q: down. E: up.");
  canvas.addEventListener("pointerdown", () => canvas.focus({ preventScroll: true }));
  canvas.addEventListener("keydown", (event) => {
    if (mode !== "path") return;
    if (!movementKeys.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    pressedKeys.add(event.code);
  });
  window.addEventListener("keyup", (event) => pressedKeys.delete(event.code));
  canvas.addEventListener("blur", () => pressedKeys.clear());
  window.addEventListener("blur", () => pressedKeys.clear());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pressedKeys.clear();
  });
  canvas.addEventListener("wheel", (event) => {
    if (mode !== "path") return;
    event.preventDefault();

    const nextCameraZOffset = clamp(
      cameraZOffset + event.deltaY * CAMERA_Z_SCROLL_SPEED,
      CAMERA_Z_MIN,
      CAMERA_Z_MAX,
    );

    if (nextCameraZOffset !== cameraZOffset) {
      cameraZOffset = nextCameraZOffset;
      resetAccumulation();
    }
  }, { passive: false });

  // Translate the camera and its look-at target together. WASD follows the
  // current yaw on the ground plane; QE remains aligned with world up.
  function updateCamera(deltaSeconds) {
    const forward = Number(pressedKeys.has("KeyW")) - Number(pressedKeys.has("KeyS"));
    const right = Number(pressedKeys.has("KeyD")) - Number(pressedKeys.has("KeyA"));
    const up = Number(pressedKeys.has("KeyE")) - Number(pressedKeys.has("KeyQ"));
    const length = Math.hypot(forward, right, up);
    if (length === 0) return;

    // Match makeCameraRay's yaw; normalize input to avoid faster diagonal motion.
    const yaw = -0.5 + mouseX / Math.max(canvas.width, 1);
    const step = CAMERA_MOVE_SPEED * deltaSeconds / length;
    cameraOffset[0] += (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * step;
    cameraOffset[1] += up * step;
    cameraOffset[2] += (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * step;
    resetAccumulation();
  }

  function renderEnvMap(deltaSeconds) {
    const p = envParams;
    if (p.autoRotate) envTarget.yaw += deltaSeconds * 0.35;
    // Exponential smoothing keeps fast mouse moves from jumping.
    const k = 1 - Math.exp(-deltaSeconds * 10);
    envCurrent.yaw += (envTarget.yaw - envCurrent.yaw) * k;
    envCurrent.pitch += (envTarget.pitch - envCurrent.pitch) * k;

    requestEnv(p.env);
    // Keep showing the previous environment until the new one has loaded.
    const texture = envTextures[p.env] ?? Object.values(envTextures)[0];
    const exposure = envTextures[p.env] ? ENVIRONMENTS[p.env].exposure : 1.0;

    render(
      gl,
      geometry,
      envMapMaterial,
      {
        u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
        u_normalMap: { type: "1i", value: 0 },
        u_mask: { type: "1i", value: 1 },
        u_env: { type: "1i", value: 2 },
        u_envRotation: { type: "mat3", value: envRotationMatrix(envCurrent.yaw, envCurrent.pitch) },
        u_exposure: { type: "1f", value: exposure },
        u_material: { type: "1i", value: p.mirror ? 1 : 0 },
        u_showNormals: { type: "1i", value: p.showNormals ? 1 : 0 },
      },
      [
        { handle: normalMapTextures.normal },
        { handle: normalMapTextures.mask },
        { handle: texture },
      ],
    );
  }

  function renderNormalMap(now) {
    const p = normalMapParams;
    if (p.orbit) {
      const angle = (now - startTime) * 0.0006;
      lightUv[0] = 0.5 + 0.38 * Math.cos(angle);
      lightUv[1] = 0.55 + 0.32 * Math.sin(angle);
    }

    render(
      gl,
      geometry,
      normalMapMaterial,
      {
        u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
        u_normalMap: { type: "1i", value: 0 },
        u_normalBack: { type: "1i", value: 1 },
        u_albedo: { type: "1i", value: 2 },
        u_mask: { type: "1i", value: 3 },
        u_light: { type: "2f", value: lightUv },
        u_lightHeight: { type: "1f", value: p.lightHeight },
        u_colorShift: { type: "1f", value: p.colorShift },
        u_showNormals: { type: "1i", value: p.showNormals ? 1 : 0 },
      },
      [
        { handle: normalMapTextures.normal },
        { handle: normalMapTextures.normalBack },
        { handle: normalMapTextures.albedo },
        { handle: normalMapTextures.mask },
      ],
    );
  }

  function frame(now) {
    // Bound elapsed time after a stalled/background frame to prevent large jumps.
    const deltaSeconds = Math.min(Math.max((now - previousFrameTime) * 0.001, 0), 0.05);
    previousFrameTime = now;
    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    const resized = resizeCanvasToDisplaySize(canvas);
    if (resized) {
      // Preserve the normalized camera pose across initial sizing and resizes.
      mouseX *= canvas.width / Math.max(previousWidth, 1);
      mouseY *= canvas.height / Math.max(previousHeight, 1);
    }
    if (resized || accumulationTargets.length === 0) {
      deleteAccumulationTargets(gl, accumulationTargets);
      accumulationTargets = createAccumulationTargets(gl, gl.canvas.width, gl.canvas.height);
      resetAccumulation();
    }

    if (mode === "env") {
      renderEnvMap(deltaSeconds);
      requestAnimationFrame(frame);
      return;
    }
    if (mode === "normal") {
      renderNormalMap(now);
      requestAnimationFrame(frame);
      return;
    }

    updateCamera(deltaSeconds);
    const readTarget = accumulationTargets[readTargetIndex];
    const writeTarget = accumulationTargets[1 - readTargetIndex];

    const uniforms = {
      u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
      u_previousFrame: { type: "1i", value: 0 },
      u_frame: { type: "1i", value: frameIndex },
      u_cameraZOffset: { type: "1f", value: cameraZOffset },
      u_cameraOffset: { type: "3f", value: cameraOffset },
      u_mouse: {
        type: "2f",
        value: [
          gl.canvas.width > 0 ? mouseX / gl.canvas.width : 0,
          gl.canvas.height > 0 ? mouseY / gl.canvas.height : 0,
        ],
      },
      u_time: { type: "1f", value: (performance.now() - startTime) * 0.001 },
    };

    render(
      gl,
      geometry,
      material,
      uniforms,
      [{ handle: readTarget.texture }],
      {
        framebuffer: writeTarget.framebuffer,
        width: writeTarget.width,
        height: writeTarget.height,
        clear: false,
      },
    );

    render(
      gl,
      geometry,
      displayMaterial,
      {
        u_accumulation: { type: "1i", value: 0 },
      },
      [{ handle: writeTarget.texture }],
    );

    readTargetIndex = 1 - readTargetIndex;
    frameIndex += 1;
    requestAnimationFrame(frame);
  }

  setMode(mode);
  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
});
