import "./style.css";

import vertexShaderSource from "./shader/basic.vert?raw";
import fragmentShaderSource from "./shader/path_trace.frag?raw";
import displayShaderSource from "./shader/display.frag?raw";

import { render } from "./renderer.js";
import { compileShader, linkProgram } from "./webgl-utils.js";

const CAMERA_Z_SCROLL_SPEED = 0.002;
const CAMERA_Z_MIN = -2.5;
const CAMERA_Z_MAX = 2.0;

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
  const material = linkProgram(gl, vertexShader, fragmentShader);
  const displayMaterial = linkProgram(gl, vertexShader, displayFragmentShader);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.deleteShader(displayFragmentShader);

  const geometry = createFullscreenQuad(gl, material.program);

  let mouseX = canvas.width;
  let mouseY = canvas.height;
  let frameIndex = 0;
  let readTargetIndex = 0;
  let accumulationTargets = [];
  let cameraZOffset = 0;
  const startTime = performance.now();

  function resetAccumulation() {
    frameIndex = 0;
    readTargetIndex = 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
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
  canvas.addEventListener("wheel", (event) => {
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
      u_cameraZOffset: { type: "1f", value: cameraZOffset },
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
