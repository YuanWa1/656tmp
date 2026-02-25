  import './style.css'
  import { mat4, vec3, vec4 } from "gl-matrix";

  import vertexShaderSource from "./shader/basic.vert?raw";
  import BlinnPhongShaderSource from "./shader/BlinnPhong.frag?raw";
  import FresnelShaderSource from "./shader/Fresnel.frag?raw";

  function createShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (success) {
      return shader;
    }

    console.log(gl.getShaderInfoLog(shader));  // eslint-disable-line
    gl.deleteShader(shader);
    return undefined;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    var success = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (success) {
      return program;
    }

    console.log(gl.getProgramInfoLog(program));  // eslint-disable-line
    gl.deleteProgram(program);
    return undefined;
  }

  function initGL(){
    const canvas = document.querySelector("#glcanvas");
    
    const gl = canvas.getContext("webgl2");

    return{gl,canvas};
  }

  function createQuad(gl,program){
    var positionAttributeLocation = gl.getAttribLocation(program, "a_position");

    // Create a buffer and put three 2d clip space points in it
    var vbo = gl.createBuffer();

    // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    var positions = [
      -1,-1,
      -1,1,
      1,1,
      -1,-1,
      1,-1,
      1,1,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    // Create a vertex array object (attribute state)
    var vao = gl.createVertexArray();

    // and make it the one we're currently working with
    gl.bindVertexArray(vao);

    // Turn on the attribute
    gl.enableVertexAttribArray(positionAttributeLocation);

    // Tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)
    var size = 2;          // 2 components per iteration
    var type = gl.FLOAT;   // the data is 32bit floats
    var normalize = false; // don't normalize the data
    var stride = 0;        // 0 = move forward size * sizeof(type) each iteration to get the next position
    var offset = 0;        // start at the beginning of the buffer
    gl.vertexAttribPointer(
        positionAttributeLocation, size, type, normalize, stride, offset);

    gl.bindVertexArray(null);

    return {vao,vbo};
  }

  function createTexture(gl,image, type){
      // Create a texture.
      var texture = gl.createTexture();
    
      // make unit 0 the active texture uint
      // (ie, the unit all other texture commands will affect
      const count = (type === "base") ? 0 :
                  (type === "normal") ? 1 :
                  (type === "ambient") ? 2 :
                  (() => { throw new Error("bad type: " + type); })();

      console.log(`Creating texture for ${type} at unit ${count}`);
      gl.activeTexture(gl.TEXTURE0 + count);

      // Bind it to texture unit 0' 2D bind point
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Set the parameters so we don't need mips and so we're not filtering
      // and we don't repeat
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if(type === "normal"){
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
      // Upload the image into the texture.
      var mipLevel = 0;               // the largest mip

      var internalFormat = gl.SRGB8_ALPHA8; 
      if(type === "normal"){
        var internalFormat = gl.RGBA8;
      }
      var srcFormat = gl.RGBA;        // format of data we are supplying
      var srcType = gl.UNSIGNED_BYTE  // type of data we are supplying
      gl.texImage2D(gl.TEXTURE_2D,
                    mipLevel,
                    internalFormat,
                    srcFormat,
                    srcType,
                    image);
      
      gl.generateMipmap(gl.TEXTURE_2D);

      return texture;
    }

  function render(gl,program,vao,vbo,mouseX,mouseY,time,n1,n2){
      // Tell WebGL how to convert from clip space to pixels
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

      //Should be moved to init later
      const mouseLocation = gl.getUniformLocation(program, "u_mouse");
      const resolutionUniformLocation = gl.getUniformLocation(program,"u_resolution");
      const BaseimageLocation = gl.getUniformLocation(program, "u_base");
      const n1Location = gl.getUniformLocation(program, "n1");
      const n2Location = gl.getUniformLocation(program, "n2");
      // const NormalimageLocation = gl.getUniformLocation(program, "u_normal");
      // const AmbientimageLocation = gl.getUniformLocation(program, "u_ambient");


      // Clear the canvas
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Tell it to use our program (pair of shaders)
      gl.useProgram(program);

      // Bind the attribute/buffer set we want.
      gl.bindVertexArray(vao);

      gl.uniform2f(resolutionUniformLocation, gl.canvas.width, gl.canvas.height);


      // Pass the mouse position
      gl.uniform2f(mouseLocation, mouseX, mouseY);
      gl.uniform1f(n1Location, n1);
      gl.uniform1f(n2Location, n2);

      gl.uniform1i(BaseimageLocation, 0); // texture unit 0
      // gl.uniform1i(NormalimageLocation, 1); // texture unit 1
      // gl.uniform1i(AmbientimageLocation, 2); // texture unit 2

      // Draw the rectangle.
      var primitiveType = gl.TRIANGLES;
      var offset = 0;
      var count = 6;
      gl.drawArrays(primitiveType, offset, count);
    }

  async function loadBitmap(url) {
    console.log(`Loading image: ${url}`);
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob,{imageOrientation: 'flipY'});
  }

  async function main() {
    const {canvas,gl} = initGL();
    if (!gl) return;

    var vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    // var BlinnPhongfragmentShader = createShader(gl, gl.FRAGMENT_SHADER, BlinnPhongShaderSource);
    var FresnelfragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FresnelShaderSource);

    // Link the two shaders into a program
    var program = createProgram(gl, vertexShader, FresnelfragmentShader);

    // look up where the vertex data needs to go.

    const { vao: vao_quad, vbo: vbo_fullscreen_quad } = createQuad(gl,program);
    
    const basePath = import.meta.env.BASE_URL;
    
    const baseBitmap   = await loadBitmap(`${basePath}pics/base_p2.png`);
    // const normalBitmap = await loadBitmap(`${basePath}pics/normal.png`);
    // const ambientBitmap = await loadBitmap(`${basePath}pics/ambient.png`);

    const baseTex   = createTexture(gl, baseBitmap, "base");
    // const normalTex = createTexture(gl, normalBitmap, "normal");
    // const ambientTex = createTexture(gl, ambientBitmap, "ambient");


    let mouseX = 0;
    let mouseY = 0;
    let n1 = 1.0;
    let n2 = 1.2;

    function setMousePosition(e) {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = rect.height - (e.clientY - rect.top) - 1;  // bottom is 0 in WebGL
      // console.log(`Mouse position: (${mouseX}, ${mouseY})`);
    }
    canvas.addEventListener('mousemove', setMousePosition);

    // Connect n1 and n2 sliders and inputs
    const n1Slider = document.getElementById('n1-slider');
    const n2Slider = document.getElementById('n2-slider');
    const n1Input = document.getElementById('n1-input');
    const n2Input = document.getElementById('n2-input');

    function updateN1FromSlider(value) {
      n1 = value / 10.0;
      n1Input.value = n1.toFixed(1);
    }

    function updateN2FromSlider(value) {
      n2 = value / 10.0;
      n2Input.value = n2.toFixed(1);
    }

    function updateN1FromInput(value) {
      n1 = Math.max(0.1, Math.min(30.0, parseFloat(value)));
      n1Slider.value = Math.round(n1 * 10);
      n1Input.value = n1.toFixed(1);
    }

    function updateN2FromInput(value) {
      n2 = Math.max(0.1, Math.min(30.0, parseFloat(value)));
      n2Slider.value = Math.round(n2 * 10);
      n2Input.value = n2.toFixed(1);
    }

    function setSliderValues(n1Val, n2Val) {
      n1Slider.value = Math.round(n1Val * 10);
      n2Slider.value = Math.round(n2Val * 10);
      updateN1FromSlider(n1Slider.value);
      updateN2FromSlider(n2Slider.value);
    }

    n1Slider.addEventListener('input', (e) => updateN1FromSlider(parseInt(e.target.value)));
    n2Slider.addEventListener('input', (e) => updateN2FromSlider(parseInt(e.target.value)));
    n1Input.addEventListener('input', (e) => updateN1FromInput(e.target.value));
    n2Input.addEventListener('input', (e) => updateN2FromInput(e.target.value));

    // Connect checkboxes for mutual exclusion and parameter presets
    const allReflectionCheckbox = document.getElementById('all-reflection-checkbox');
    const regularCheckbox = document.getElementById('regular-checkbox');

    allReflectionCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        regularCheckbox.checked = false;
        setSliderValues(0.0, 2.0);  // n1=0, n2=2.0
      } else {
        // Ensure at least one is checked
        regularCheckbox.checked = true;
        setSliderValues(1.0, 1.2);
      }
    });

    regularCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        allReflectionCheckbox.checked = false;
        setSliderValues(1.0, 1.2);  // n1=1.0, n2=1.2
      } else {
        // Ensure at least one is checked
        allReflectionCheckbox.checked = true;
        setSliderValues(0.0, 2.0);
      }
    });

    // Initialize with Regular mode (default)
    setSliderValues(1.0, 1.2);

      function frame(time) {
        render(gl, program, vao_quad, vbo_fullscreen_quad, mouseX, mouseY, time, n1, n2);

        requestAnimationFrame(frame);
      }

    requestAnimationFrame(frame);
  }

  main();
