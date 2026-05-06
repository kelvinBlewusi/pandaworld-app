"use client";
import { useEffect, useRef } from "react";

const VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Neon Horizon — retro perspective grid with sunset sky
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

void main(){
  vec2 uv = v_uv;
  vec2 m = u_mouse - 0.5;

  float horizon = 0.52 + m.y * 0.10;
  float tilt    = m.x  * 0.30;

  vec3 col;
  if (uv.y < horizon) {
    float depth = horizon - uv.y;
    float invD  = 1.0 / (depth + 0.0001);
    float roll  = u_time * 0.55;
    float gx    = (uv.x - 0.5 + tilt * depth) * invD * 1.4;
    float gz    = invD - roll;
    float lx    = abs(fract(gx) - 0.5);
    float lz    = abs(fract(gz) - 0.5);
    float lineW = 0.025 + depth * 0.045;
    float gl_   = smoothstep(lineW, 0.0, lx) + smoothstep(lineW, 0.0, lz);
    float fade  = smoothstep(0.0, 0.55, depth);
    vec3 ground = mix(vec3(0.07, 0.01, 0.12), vec3(0.02, 0.0, 0.05), 1.0 - fade);
    vec3 neon   = mix(vec3(1.0, 0.22, 0.65), vec3(0.25, 0.85, 1.0),
                       0.5 + 0.5 * sin(uv.x * 2.8 + u_time * 0.35));
    col = ground + neon * gl_ * fade * 1.4;
  } else {
    float sy   = (uv.y - horizon) / max(1.0 - horizon, 0.001);
    vec3  sky  = mix(vec3(0.48, 0.05, 0.58), vec3(0.03, 0.0, 0.09), sy);
    vec2  sunC = vec2(0.5 + m.x * 0.18, horizon + 0.17);
    float sd   = length((uv - sunC) * vec2(1.0, 1.75));
    float sun  = smoothstep(0.23, 0.0, sd);
    float bands = step(0.0, sin((uv.y - horizon) * 62.0 - u_time * 1.1));
    sun *= mix(1.0, bands, smoothstep(0.0, 0.17, uv.y - horizon));
    vec3 sunCol = mix(vec3(1.0, 0.52, 0.18), vec3(1.0, 0.88, 0.32), clamp(1.0 - sd * 3.0, 0.0, 1.0));
    col = sky + sun * sunCol * 1.35;
    float st = h21(floor(uv * vec2(220.0, 140.0)));
    col += step(0.993, st) * 0.55 * sy;
  }

  // scanlines + vignette
  col *= 0.93 + 0.07 * sin(uv.y * u_res.y);
  col *= smoothstep(1.55, 0.42, length(uv - 0.5)) * 0.38 + 0.72;

  outColor = vec4(col, 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[ShaderBackground]", gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

export default function ShaderBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) return;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uRes   = gl.getUniformLocation(prog, "u_res");
    const uTime  = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");

    const dpr    = Math.min(window.devicePixelRatio || 1, 1.75);
    const mouse  = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    let   start  = performance.now();
    let   raf    = 0;

    function resize() {
      canvas!.width  = Math.floor(window.innerWidth  * dpr);
      canvas!.height = Math.floor(window.innerHeight * dpr);
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }
    resize();
    window.addEventListener("resize", resize);

    function onMove(e: MouseEvent) {
      mouse.tx = e.clientX / window.innerWidth;
      mouse.ty = 1 - e.clientY / window.innerHeight;
    }
    window.addEventListener("mousemove", onMove);

    function loop(now: number) {
      mouse.x += (mouse.tx - mouse.x) * 0.06;
      mouse.y += (mouse.ty - mouse.y) * 0.06;
      const t = (now - start) / 1000;
      gl!.useProgram(prog);
      gl!.uniform2f(uRes,   canvas!.width, canvas!.height);
      gl!.uniform1f(uTime,  t);
      gl!.uniform2f(uMouse, mouse.x, mouse.y);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 h-full w-full"
      style={{ display: "block" }}
      aria-hidden="true"
    />
  );
}
