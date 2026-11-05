// Minimal Radiance .hdr (RGBE) loader -> RGBA16F texture.

function parseRgbe(buffer) {
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  const readLine = () => {
    let line = "";
    while (pos < bytes.length && bytes[pos] !== 0x0a) line += String.fromCharCode(bytes[pos++]);
    pos += 1;
    return line;
  };

  if (!readLine().startsWith("#?")) throw new Error("Not a Radiance HDR file.");
  let width = 0;
  let height = 0;
  for (;;) {
    const line = readLine();
    if (pos >= bytes.length) throw new Error("HDR header has no resolution line.");
    if (line.startsWith("FORMAT=") && line !== "FORMAT=32-bit_rle_rgbe") {
      throw new Error(`Unsupported HDR format: ${line}`);
    }
    const match = /^-Y (\d+) \+X (\d+)$/.exec(line.trim());
    if (match) {
      height = Number(match[1]);
      width = Number(match[2]);
      break;
    }
  }

  // Decode scanlines (new-style RLE or flat) into RGBE bytes.
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y += 1) {
    const isRle = width >= 8 && width < 32768
      && bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2] & 0x80) === 0;
    if (isRle) {
      pos += 4;
      for (let c = 0; c < 4; c += 1) {
        let x = 0;
        while (x < width) {
          let count = bytes[pos++];
          if (count > 128) {
            count -= 128;
            const value = bytes[pos++];
            for (let i = 0; i < count; i += 1) scan[(x++) * 4 + c] = value;
          } else {
            for (let i = 0; i < count; i += 1) scan[(x++) * 4 + c] = bytes[pos++];
          }
        }
      }
    } else {
      scan.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    rgbe.set(scan, y * width * 4);
  }

  // RGBE -> linear float. Clamp to the half-float range (the sun can exceed it).
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const e = rgbe[i * 4 + 3];
    const scale = e === 0 ? 0 : 2 ** (e - 136);
    data[i * 4] = Math.min(rgbe[i * 4] * scale, 65000);
    data[i * 4 + 1] = Math.min(rgbe[i * 4 + 1] * scale, 65000);
    data[i * 4 + 2] = Math.min(rgbe[i * 4 + 2] * scale, 65000);
    data[i * 4 + 3] = 1;
  }
  return { width, height, data };
}

// Diffuse irradiance: for each output direction N, the cosine-weighted
// integral of the environment over the hemisphere around N, divided by PI so
// a white Lambertian surface shows E(N) * albedo directly. Computed once on
// load from a box-downsampled copy; irradiance is so smooth that a 32x16
// result is plenty.
function computeIrradiance(width, height, data, outW = 32, outH = 16) {
  const srcW = 64;
  const srcH = 32;
  const fx = width / srcW;
  const fy = height / srcH;
  const src = new Float32Array(srcW * srcH * 3);
  const dirs = new Float32Array(srcW * srcH * 3);
  for (let y = 0; y < srcH; y += 1) {
    const theta = ((y + 0.5) / srcH) * Math.PI;
    // Solid angle of an equirect texel shrinks toward the poles.
    const solidAngle = (2 * Math.PI / srcW) * (Math.PI / srcH) * Math.sin(theta);
    for (let x = 0; x < srcW; x += 1) {
      const phi = ((x + 0.5) / srcW - 0.5) * 2 * Math.PI;
      const o = (y * srcW + x) * 3;
      // Same convention as directionToEquirect(): u = atan(x, -z), v = acos(y).
      dirs[o] = Math.sin(theta) * Math.sin(phi);
      dirs[o + 1] = Math.cos(theta);
      dirs[o + 2] = -Math.sin(theta) * Math.cos(phi);
      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = Math.floor(y * fy); sy < Math.floor((y + 1) * fy); sy += 1) {
        for (let sx = Math.floor(x * fx); sx < Math.floor((x + 1) * fx); sx += 1) {
          const i = (sy * width + sx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count += 1;
        }
      }
      const w = solidAngle / count;
      src[o] = r * w; src[o + 1] = g * w; src[o + 2] = b * w;
    }
  }

  const out = new Float32Array(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const theta = ((y + 0.5) / outH) * Math.PI;
    for (let x = 0; x < outW; x += 1) {
      const phi = ((x + 0.5) / outW - 0.5) * 2 * Math.PI;
      const nx = Math.sin(theta) * Math.sin(phi);
      const ny = Math.cos(theta);
      const nz = -Math.sin(theta) * Math.cos(phi);
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < srcW * srcH; k += 1) {
        const c = nx * dirs[k * 3] + ny * dirs[k * 3 + 1] + nz * dirs[k * 3 + 2];
        if (c > 0) { r += src[k * 3] * c; g += src[k * 3 + 1] * c; b += src[k * 3 + 2] * c; }
      }
      const o = (y * outW + x) * 4;
      out[o] = r / Math.PI; out[o + 1] = g / Math.PI; out[o + 2] = b / Math.PI; out[o + 3] = 1;
    }
  }
  return { width: outW, height: outH, data: out };
}

function createFloatTexture(gl, width, height, data, mipmaps) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

// Row 0 of the file (straight up) lands at v = 0. The radiance texture is
// mipmapped: mips filter curved silhouettes and double as a cheap prefilter
// for rough reflections. RGBA16F is filterable in WebGL2; generating its mips
// needs EXT_color_buffer_float.
export async function loadEnvironment(gl, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const { width, height, data } = parseRgbe(await response.arrayBuffer());
  const irradiance = computeIrradiance(width, height, data);
  return {
    radiance: createFloatTexture(gl, width, height, data, true),
    irradiance: createFloatTexture(gl, irradiance.width, irradiance.height, irradiance.data, false),
    width,
    maxLod: Math.floor(Math.log2(Math.max(width, height))),
  };
}
