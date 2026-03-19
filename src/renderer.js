function uploadUniform(gl, location, uniform) {
    const { type, value } = uniform;

    switch (type) {
        case "1f":
            gl.uniform1f(location, value);
            break;
        case "2f":
            gl.uniform2f(location, value[0], value[1]);
            break;
        case "3f":
            gl.uniform3f(location, value[0], value[1], value[2]);
            break;
        case "1i":
            gl.uniform1i(location, value);
            break;
        case "2fv":
            gl.uniform2fv(location, value);
            break;
        case "3fv":
            gl.uniform3fv(location, value);
            break;
        default:
            throw new Error(`Unsupported uniform type: ${type}`);
    }
}

function bindTextureSlots(gl, textureSlots) {
    for (let i = 0; i < 8; i += 1) {
        const slot = textureSlots[i];
        if (!slot || !slot.handle) {
            continue;
        }

        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, slot.handle);
    }
}

export function render(gl, geometry, material, uniforms, textureSlots = []) {
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(material.program);
    bindTextureSlots(gl, textureSlots);
    gl.bindVertexArray(geometry.vao);

    for (const [name, uniform] of Object.entries(uniforms)) {
        const location = material.uniformLocations[name];
        if (location == null) {
            continue;
        }
        uploadUniform(gl, location, uniform);
    }

    gl.drawArrays(geometry.drawMode ?? gl.TRIANGLES, 0, geometry.count);
    gl.bindVertexArray(null);
}