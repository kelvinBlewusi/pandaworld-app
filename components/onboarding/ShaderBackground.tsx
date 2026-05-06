"use client";
import { useEffect, useRef } from "react";

/* ─── Vertex shader ──────────────────────────────────────────────────────── */
const VERT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/* ─── Neon Horizon fragment shader ───────────────────────────────────────── */
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;

float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

void main(){
  vec2 uv = v_uv;
  vec2 m  = u_mouse - 0.5;

  float horizon = 0.52 + m.y * 0.10;
  float tilt    = m.x  * 0.30;

  vec3 col;
  if(uv.y < horizon){
    float depth = horizon - uv.y;
    float invD  = 1.0 / (depth + 0.0001);
    float roll  = u_time * 0.55;
    float gx    = (uv.x - 0.5 + tilt * depth) * invD * 1.4;
    float gz    = invD - roll;
    float lx    = abs(fract(gx) - 0.5);
    float lz    = abs(fract(gz) - 0.5);
    float lw    = 0.025 + depth * 0.045;
    float gl_   = smoothstep(lw, 0.0, lx) + smoothstep(lw, 0.0, lz);
    float fade  = smoothstep(0.0, 0.55, depth);
    vec3  ground = mix(vec3(0.07,0.01,0.12), vec3(0.02,0.0,0.05), 1.0-fade);
    vec3  neon   = mix(vec3(1.0,0.22,0.65), vec3(0.25,0.85,1.0),
                       0.5+0.5*sin(uv.x*2.8+u_time*0.35));
    col = ground + neon * gl_ * fade * 1.4;
  } else {
    float sy  = (uv.y - horizon) / max(1.0 - horizon, 0.001);
    vec3  sky = mix(vec3(0.48,0.05,0.58), vec3(0.03,0.0,0.09), sy);
    vec2  sc  = vec2(0.5 + m.x*0.18, horizon + 0.17);
    float sd  = length((uv - sc)*vec2(1.0,1.75));
    float sun = smoothstep(0.23, 0.0, sd);
    float bnd = step(0.0, sin((uv.y-horizon)*62.0 - u_time*1.1));
    sun *= mix(1.0, bnd, smoothstep(0.0, 0.17, uv.y-horizon));
    vec3 sc2  = mix(vec3(1.0,0.52,0.18), vec3(1.0,0.88,0.32),
                    clamp(1.0-sd*3.0, 0.0, 1.0));
    col = sky + sun * sc2 * 1.35;
    float st = h21(floor(uv*vec2(220.0,140.0)));
    col += step(0.993, st) * 0.55 * sy;
  }

  col *= 0.93 + 0.07*sin(uv.y*u_res.y);
  col *= smoothstep(1.55, 0.42, length(uv-0.5))*0.38 + 0.72;
  outColor = vec4(col, 1.0);
}`;

function makeShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("[ShaderBg]", gl.getShaderInfoLog(s)); return null;
  }
  return s;
}

/* ─── WebGL canvas (mounted client-side) ─────────────────────────────────── */
function WebGLCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) return;

    const vs = makeShader(gl, gl.VERTEX_SHADER,   VERT);
    const fs = makeShader(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[ShaderBg] link:", gl.getProgramInfoLog(prog)); return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uRes   = gl.getUniformLocation(prog, "u_res");
    const uTime  = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");

    const mouse  = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const start  = performance.now();
    let   raf    = 0;

    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas!.width  = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      canvas!.style.width  = w + "px";
      canvas!.style.height = h + "px";
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }
    resize();

    const onResize = () => resize();
    const onMove   = (e: MouseEvent) => {
      mouse.tx = e.clientX / window.innerWidth;
      mouse.ty = 1 - e.clientY / window.innerHeight;
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMove);

    function loop(now: number) {
      mouse.x += (mouse.tx - mouse.x) * 0.06;
      mouse.y += (mouse.ty - mouse.y) * 0.06;
      gl!.useProgram(prog);
      gl!.uniform2f(uRes,   canvas!.width, canvas!.height);
      gl!.uniform1f(uTime,  (now - start) / 1000);
      gl!.uniform2f(uMouse, mouse.x, mouse.y);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
      gl.deleteProgram(prog); gl.deleteBuffer(buf);
      gl.deleteShader(vs);    gl.deleteShader(fs);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      style={{
        position: "fixed", top: 0, left: 0,
        display: "block", zIndex: 0,
      }}
      aria-hidden="true"
    />
  );
}

/* ─── CSS fallback — always visible, hidden by canvas once GL loads ─────── */
function CSSFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed", inset: 0, zIndex: 0,
        background: "linear-gradient(to bottom, #2a004a 0%, #12001f 48%, #06000e 100%)",
        overflow: "hidden",
      }}
    >
      {/* Retro sun */}
      <div style={{
        position: "absolute",
        left: "50%", top: "48%",
        transform: "translate(-50%, -50%)",
        width: 260, height: 130,
        borderRadius: "50% 50% 0 0",
        background: "linear-gradient(to bottom, #ffb347, #ff4f00)",
        boxShadow: "0 0 80px 30px rgba(255,100,0,0.35)",
        overflow: "hidden",
      }}>
        {/* Horizontal sun bands */}
        {[0,1,2,3,4,5].map((i) => (
          <div key={i} style={{
            position: "absolute", left: 0, right: 0,
            top: `${18 + i * 14}%`,
            height: "7%",
            background: "linear-gradient(to bottom, #12001f 0%, #12001f 100%)",
          }} />
        ))}
      </div>

      {/* Perspective grid */}
      <div style={{
        position: "absolute", left: "-20%", right: "-20%",
        top: "48%", bottom: "-20%",
        perspective: "500px",
        perspectiveOrigin: "50% 0%",
      }}>
        <div style={{
          width: "100%", height: "100%",
          transform: "rotateX(55deg)",
          transformOrigin: "50% 0%",
          backgroundImage: `
            linear-gradient(to right, rgba(220,50,240,0.55) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(220,50,240,0.55) 1px, transparent 1px)
          `,
          backgroundSize: "80px 60px",
          animation: "gridscroll 1.8s linear infinite",
        }} />
      </div>

      {/* Vignette */}
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.75) 100%)",
      }} />

      <style>{`
        @keyframes gridscroll {
          from { background-position: 0 0; }
          to   { background-position: 0 60px; }
        }
      `}</style>
    </div>
  );
}

/* ─── Exported component ─────────────────────────────────────────────────── */
export default function ShaderBackground() {
  return (
    <>
      <CSSFallback />
      <WebGLCanvas />
    </>
  );
}
