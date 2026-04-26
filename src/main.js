import "./style.css";

import vertexShaderSource from "./shader/basic.vert?raw";
import fragmentShaderSource from "./shader/path_trace.frag?raw";
import displayShaderSource from "./shader/display.frag?raw";

import { render } from "./renderer.js";
import { compileShader, createTexture2D, linkProgram } from "./webgl-utils.js";

const TEXTURE_SLOT_COUNT = 8;

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

async function loadBitmap(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load image: ${url}`);
  }

  const blob = await response.blob();
  return createImageBitmap(blob, { imageOrientation: "flipY" });
}

async function loadBitmapFromFile(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const response = await fetch(objectUrl);
    const blob = await response.blob();
    return await createImageBitmap(blob, { imageOrientation: "flipY" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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

function createTextureSlots() {
  return Array.from({ length: TEXTURE_SLOT_COUNT }, () => ({
    handle: null,
    bitmap: null,
    isLinear: false,
  }));
}

function createTextureManager(gl) {
  const slots = createTextureSlots();

  function replaceSlotTexture(index, bitmap, isLinear, options = {}) {
    const slot = slots[index];
    if (!slot) {
      throw new Error(`Invalid texture slot index: ${index}`);
    }

    if (slot.handle) {
      gl.deleteTexture(slot.handle);
      slot.handle = null;
    }

    if (slot.bitmap && slot.bitmap !== bitmap && typeof slot.bitmap.close === "function") {
      slot.bitmap.close();
    }

    slot.bitmap = bitmap;
    slot.isLinear = isLinear;
    slot.handle = createTexture2D(gl, bitmap, {
      textureUnit: index,
      isLinear,
      generateMipmaps: true,
      ...options,
    });
  }

  async function updateSlot(index, file, isLinear) {
    if (index < 0 || index >= slots.length) {
      throw new Error(`Invalid texture slot index: ${index}`);
    }

    if (!file) {
      return;
    }

    const bitmap = await loadBitmapFromFile(file);
    replaceSlotTexture(index, bitmap, isLinear);
  }

  function updateSlotLinear(index, isLinear) {
    const slot = slots[index];
    if (!slot) {
      return;
    }

    if (!slot.bitmap) {
      slot.isLinear = isLinear;
      return;
    }

    replaceSlotTexture(index, slot.bitmap, isLinear);
  }

  return {
    slots,
    updateSlot,
    updateSlotLinear,
    setSlotBitmap: replaceSlotTexture,
  };
}

function setupTextureSlotUI(textureManager) {
  for (let i = 0; i < TEXTURE_SLOT_COUNT; i += 1) {
    const fileInput = document.getElementById(`tex-file-${i}`);
    const linearInput = document.getElementById(`tex-linear-${i}`);

    if (!(fileInput instanceof HTMLInputElement) || !(linearInput instanceof HTMLInputElement)) {
      throw new Error(`Missing texture slot controls for index ${i}`);
    }

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        return;
      }

      try {
        await textureManager.updateSlot(i, file, linearInput.checked);
      } catch (error) {
        console.error(error);
      }
    });

    linearInput.addEventListener("change", () => {
      textureManager.updateSlotLinear(i, linearInput.checked);
    });
  }
}

async function main() {
  const { canvas, gl } = initGL();
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float is required for progressive rendering.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const displayFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, displayShaderSource);
  const material = linkProgram(gl, vertexShader, fragmentShader);
  const displayMaterial = linkProgram(gl, vertexShader, displayFragmentShader);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.deleteShader(displayFragmentShader);

  const geometry = createFullscreenQuad(gl, material.program);
  const textureManager = createTextureManager(gl);

  setupTextureSlotUI(textureManager);

  let mouseX = canvas.width;
  let mouseY = canvas.height;
  let frameIndex = 0;
  let readTargetIndex = 0;
  let accumulationTargets = [];
  const startTime = performance.now();

  function resetAccumulation() {
    frameIndex = 0;
    readTargetIndex = 0;
  }

  function setMousePosition(event) {
    const rect = canvas.getBoundingClientRect();
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

  function frame() {
    const resized = resizeCanvasToDisplaySize(canvas);
    if (resized || accumulationTargets.length === 0) {
      deleteAccumulationTargets(gl, accumulationTargets);
      accumulationTargets = createAccumulationTargets(gl, gl.canvas.width, gl.canvas.height);
      resetAccumulation();
    }

    const readTarget = accumulationTargets[readTargetIndex];
    const writeTarget = accumulationTargets[1 - readTargetIndex];

    const uniforms = {
      u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
      u_previousFrame: { type: "1i", value: 0 },
      u_frame: { type: "1i", value: frameIndex },
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

  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
});
