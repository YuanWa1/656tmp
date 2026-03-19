export function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return shader;
  }

  const log = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
  gl.deleteShader(shader);
  throw new Error(log);
}

function cacheUniformLocations(gl, program) {
  const uniformLocations = {};
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

  for (let i = 0; i < uniformCount; i += 1) {
    const info = gl.getActiveUniform(program, i);
    if (!info) {
      continue;
    }

    // WebGL reports array uniforms as "name[0]".
    const name = info.name.replace(/\[0\]$/, "");
    uniformLocations[name] = gl.getUniformLocation(program, name);
  }

  return uniformLocations;
}

export function linkProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "Unknown program link error.";
    gl.deleteProgram(program);
    throw new Error(log);
  }

  return {
    program,
    uniformLocations: cacheUniformLocations(gl, program),
  };
}

function getMipLevelCount(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export function createTexture2D(gl, image, options = {}) {
  const {
    textureUnit = 0,
    isLinear = false,
    internalFormat,
    format = gl.RGBA,
    type = gl.UNSIGNED_BYTE,
    wrapS = gl.CLAMP_TO_EDGE,
    wrapT = gl.CLAMP_TO_EDGE,
    generateMipmaps = true,
    minFilter = generateMipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    magFilter = gl.LINEAR,
  } = options;

  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create texture.");
  }

  const storageFormat = internalFormat ?? (isLinear ? gl.RGBA8 : gl.SRGB8_ALPHA8);

  const levels = generateMipmaps ? getMipLevelCount(image.width, image.height) : 1;

  gl.activeTexture(gl.TEXTURE0 + textureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);

  gl.texStorage2D(gl.TEXTURE_2D, levels, storageFormat, image.width, image.height);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    image.width,
    image.height,
    format,
    type,
    image,
  );

  if (generateMipmaps && levels > 1) {
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  return texture;
}