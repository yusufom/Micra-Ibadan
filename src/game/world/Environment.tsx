"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useRef } from "react";
import {
  BackSide,
  type Camera,
  Color,
  type DirectionalLight,
  FogExp2,
  type HemisphereLight,
  Mesh,
  Object3D,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { gameClock } from "@/game/core/clock";
import { useWorldStore } from "@/game/store/worldStore";
import { getQuality, type QualitySettings } from "./quality";

/** Ibadan latitude, degrees north. */
const LATITUDE = 7.39;
/** Solar noon in West Africa Time: 3.88° E sits 44 minutes behind the UTC+1 meridian. */
const SOLAR_NOON = 12.75;

/**
 * Two looks. Harmattan (December to February): dusty beige haze, a pale
 * washed-out sky and a softer, lower sun (declination about -20°). Clear:
 * rainy-season blue sky and crisp distance (declination about 0°).
 * Fog densities are FogExp2: harmattan fades hills out by ~3 km, clear by ~6 km.
 */
const LOOKS = {
  harmattan: {
    declination: -20,
    zenith: new Color("#aeb8bd"),
    horizon: new Color("#d6c4a2"),
    fogDensity: 0.00052,
    sun: 2.4,
    sunColor: new Color("#ffe3bd"),
    sky: new Color("#e6ddcc"),
    ground: new Color("#8a5a3c"),
    hemi: 0.95,
  },
  clear: {
    declination: 0,
    zenith: new Color("#4f86c6"),
    horizon: new Color("#c9d8e4"),
    fogDensity: 0.00026,
    sun: 3.1,
    sunColor: new Color("#fff4e2"),
    sky: new Color("#bcd4ee"),
    ground: new Color("#7a4d33"),
    hemi: 0.7,
  },
};

const NIGHT_SKY = new Color("#0b1020");
const DUSK_TINT = new Color("#ff9a55");

const deg = Math.PI / 180;

/** Unit vector towards the sun in game axes (+X east, +Y up, -Z north). */
export function sunDirection(hour: number, declinationDeg: number, out: Vector3): Vector3 {
  const h = (hour - SOLAR_NOON) * 15 * deg;
  const d = declinationDeg * deg;
  const phi = LATITUDE * deg;
  const east = -Math.cos(d) * Math.sin(h);
  const north = Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.cos(h) * Math.sin(phi);
  const up = Math.sin(d) * Math.sin(phi) + Math.cos(d) * Math.cos(h) * Math.cos(phi);
  return out.set(east, up, -north).normalize();
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uHaze;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(t, mix(0.45, 0.9, uHaze)));
  float c = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(c, 6.0) * mix(0.12, 0.3, uHaze) + pow(c, 64.0) * 0.4);
  col += uSunColor * smoothstep(0.9994, 0.9997, c) * mix(3.0, 1.2, uHaze);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Props = {
  /** Shadow box centre; defaults to the camera. */
  focus?: RefObject<Object3D | null>;
};

/** Sky dome, fog and sun state, mutated once per frame outside React. */
class Atmosphere {
  readonly sky: Mesh;
  readonly fog = new FogExp2(0xd6c4a2, LOOKS.harmattan.fogDensity);
  readonly target = new Object3D();
  private readonly sunDir = new Vector3();
  private readonly c = new Color();
  private readonly p = new Vector3();
  private readonly quality: QualitySettings;

  constructor(quality: QualitySettings) {
    this.quality = quality;
    const material = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uZenith: { value: new Color() },
        uHorizon: { value: new Color() },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color() },
        uHaze: { value: 1 },
      },
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new Mesh(new SphereGeometry(1, 32, 16), material);
    this.sky.name = "sky";
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
  }

  attach(scene: Scene): void {
    scene.fog = this.fog;
    scene.add(this.sky, this.target);
  }

  detach(scene: Scene): void {
    if (scene.fog === this.fog) scene.fog = null;
    scene.remove(this.sky, this.target);
    this.sky.geometry.dispose();
    (this.sky.material as ShaderMaterial).dispose();
  }

  update(harmattan: boolean, camera: Camera, focus: Vector3, sun: DirectionalLight | null, hemi: HemisphereLight | null): void {
    const look = harmattan ? LOOKS.harmattan : LOOKS.clear;
    const sunDir = sunDirection(gameClock.hourOfDay, look.declination, this.sunDir);
    const day = smoothstep(-0.08, 0.12, sunDir.y);
    const lowSun = 1 - smoothstep(0.05, 0.4, sunDir.y);

    const u = (this.sky.material as ShaderMaterial).uniforms;
    (u.uZenith.value as Color).copy(NIGHT_SKY).lerp(look.zenith, day);
    (u.uHorizon.value as Color).copy(NIGHT_SKY).lerp(this.c.copy(look.horizon).lerp(DUSK_TINT, lowSun * 0.45 * day), day);
    (u.uSunDir.value as Vector3).copy(sunDir);
    (u.uSunColor.value as Color).copy(look.sunColor).lerp(DUSK_TINT, lowSun).multiplyScalar(day);
    u.uHaze.value = harmattan ? 1 : 0;

    // Fog fades distant hills into the horizon colour.
    this.fog.color.copy(u.uHorizon.value as Color);
    this.fog.density = look.fogDensity;

    // The sky dome rides with the camera, just inside the far plane.
    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(this.quality.viewDistance * 0.9);

    if (sun) {
      sun.intensity = look.sun * smoothstep(-0.02, 0.15, sunDir.y);
      sun.color.copy(look.sunColor).lerp(DUSK_TINT, lowSun * 0.7);
      // Keep the shadow box on the focus, snapped to whole shadow texels to stop shimmer.
      const texel = (this.quality.shadowExtent * 2) / this.quality.shadowMapSize;
      this.p.set(Math.round(focus.x / texel) * texel, focus.y, Math.round(focus.z / texel) * texel);
      this.target.position.copy(this.p);
      sun.position.copy(this.p).addScaledVector(sunDir, 500);
      sun.target = this.target;
    }
    if (hemi) {
      hemi.color.copy(look.sky).lerp(NIGHT_SKY, 1 - day);
      hemi.groundColor.copy(look.ground);
      hemi.intensity = look.hemi * (0.15 + 0.85 * day);
    }
  }
}

/**
 * Sun, sky and haze for Ibadan, driven by gameClock.hourOfDay (10:00 by
 * default). Everything updates in useFrame; nothing here re-renders React.
 */
export function Environment({ focus }: Props) {
  const quality = getQuality();
  const scene = useThree((s) => s.scene);
  const sunRef = useRef<DirectionalLight>(null);
  const hemiRef = useRef<HemisphereLight>(null);
  const atmosphere = useRef<Atmosphere | null>(null);

  useEffect(() => {
    const a = new Atmosphere(quality);
    a.attach(scene);
    atmosphere.current = a;
    // ?haze=0 starts with clear air.
    if (new URLSearchParams(window.location.search).get("haze") === "0") useWorldStore.getState().setHarmattan(false);
    return () => {
      a.detach(scene);
      atmosphere.current = null;
    };
  }, [scene, quality]);

  useFrame(({ camera }) => {
    const f = focus?.current?.position ?? camera.position;
    atmosphere.current?.update(useWorldStore.getState().harmattan, camera, f, sunRef.current, hemiRef.current);
  });

  const e = quality.shadowExtent;
  return (
    <>
      <hemisphereLight ref={hemiRef} args={["#e6ddcc", "#8a5a3c", 0.9]} />
      <directionalLight
        ref={sunRef}
        intensity={2.4}
        castShadow={quality.shadows}
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-camera-near={1}
        shadow-camera-far={1000}
        shadow-camera-left={-e}
        shadow-camera-right={e}
        shadow-camera-top={e}
        shadow-camera-bottom={-e}
      />
    </>
  );
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
