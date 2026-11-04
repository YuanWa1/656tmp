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

// Row 0 of the file (straight up) lands at v = 0. Mipmapped so reflections on
// strongly curved silhouettes are filtered instead of shimmering. RGBA16F is
// filterable in WebGL2; generating its mips needs EXT_color_buffer_float.
export async function loadHdrTexture(gl, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const { width, height, data } = parseRgbe(await response.arrayBuffer());

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
