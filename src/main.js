import "./style.css";

import vertexShaderSource from "./shader/basic.vert?raw";
import FragShaderSource from "./shader/Shadow.frag?raw";

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
  const width = Math.floor(canvas.clientWidth * pixelRatio);
  const height = Math.floor(canvas.clientHeight * pixelRatio);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
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

  function replaceSlotTexture(index, bitmap, isLinear,options = {}) {
    const slot = slots[index];
    if (!slot) {
      throw new Error(`Invalid texture slot index: ${index}`);
    }

    // Delete old texture before creating a new one to avoid leaking GPU memory.
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

function createTextureUnitUniforms() {
  const uniforms = {};

  for (let i = 0; i < TEXTURE_SLOT_COUNT; i += 1) {
    uniforms[`u_tex${i}`] = { type: "1i", value: i };
  }

  return uniforms;
}

async function main() {
  const { canvas, gl } = initGL();

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FragShaderSource);
  const material = linkProgram(gl, vertexShader, fragmentShader);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  const geometry = createFullscreenQuad(gl, material.program);

  const textureManager = createTextureManager(gl);
  setupTextureSlotUI(textureManager);

  const basePath = import.meta.env.BASE_URL;
  const baseBitmap = await loadBitmap(`${basePath}pics/hw31.png`);
  const baseBitmap2 = await loadBitmap(`${basePath}pics/hw32.png`);

  textureManager.setSlotBitmap(0, baseBitmap, true);
  textureManager.setSlotBitmap(1, baseBitmap2, true);

  let mouseX = canvas.width;
  let mouseY = canvas.height;
  const textureUnitUniforms = createTextureUnitUniforms();

  function setMousePosition(event) {
    const rect = canvas.getBoundingClientRect();
    mouseX = event.clientX - rect.left;
    mouseY = rect.height - (event.clientY - rect.top) - 1;
    console.log(mouseX,mouseY,canvas.width, canvas.height); 
  }

  canvas.addEventListener("mousemove", setMousePosition);

  function frame() {
    resizeCanvasToDisplaySize(canvas);

    const uniforms = {
      u_resolution: { type: "2f", value: [gl.canvas.width, gl.canvas.height] },
      u_mouse: { type: "2f", value: [mouseX, mouseY] },
      ...textureUnitUniforms,
    };

    render(gl, geometry, material, uniforms, textureManager.slots);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((error) => {
  console.error(error);
});