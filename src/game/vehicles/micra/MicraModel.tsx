"use client";

import { type Ref, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Texture,
} from "three";
import { MICRA_DEFAULT_STICKER, MICRA_LIVERY as C, MICRA_PLATE, MICRA_SIGNWRITING } from "@/game/config/livery";
import { buildMicraGeometry, buildNeedle, buildSteeringWheel, type Quad } from "./micraGeometry";

/**
 * Moving parts of the model. A future .glb MicraModel must expose the same
 * rig (named nodes mapped onto these) so Micra.tsx keeps working unchanged.
 */
export type MicraRig = {
  /** Per wheel (FL, FR, RL, RR): `pivot` sits at the suspension hard point; set its y and steering yaw. `squash` flattens a burst tyre; `spin` rolls about X. */
  wheels: { pivot: Group; squash: Group; spin: Group; hardPoint: [number, number, number] }[];
  /** Body, glass and interior; tilted for visual roll/pitch. Wheels are outside it. */
  lean: Group;
  steeringWheel: Group;
  speedoNeedle: Group;
  brakeLights: MeshStandardMaterial;
  /** Rear-view mirror face. Put a render-target texture in `map` (it is already flipped like a mirror). */
  mirror: MeshBasicMaterial;
  /** Hide this while rendering the mirror image. */
  mirrorMesh: Mesh;
};

type Props = {
  passengers?: number;
  luggageKg?: number;
  /** Hide the driver for the cockpit camera. */
  showDriver?: boolean;
  /** Text in the back-window sticker slot; "" for none. */
  sticker?: string;
  castShadow?: boolean;
  ref?: Ref<MicraRig>;
};

/** Lean pivot height: roughly the roll centre. */
const LEAN_Y = 0.5;

function quadGeometry(q: Quad, flipU = false): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(q.flat()), 3));
  const u = flipU ? [1, 0, 0, 1] : [0, 1, 1, 0];
  g.setAttribute("uv", new BufferAttribute(new Float32Array([u[0], 0, u[1], 0, u[2], 1, u[3], 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Hand-painted fleet number and route under a small garage badge. */
function signwritingTexture(): CanvasTexture {
  return canvasTexture(512, 256, (ctx) => {
    ctx.fillStyle = C.signwriting;
    ctx.strokeStyle = "rgba(20,10,10,0.55)";
    ctx.lineWidth = 6;
    ctx.textAlign = "center";
    // Garage badge.
    ctx.beginPath();
    ctx.ellipse(256, 40, 150, 30, 0, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = C.signwriting;
    ctx.stroke();
    ctx.font = "bold 30px Arial, sans-serif";
    ctx.fillText(MICRA_SIGNWRITING.garage, 256, 51);
    // Big brush-style number, slightly slanted and uneven.
    ctx.save();
    ctx.translate(256, 170);
    ctx.transform(1, 0, -0.12, 1, 0, 0);
    ctx.font = "900 112px Impact, 'Arial Black', sans-serif";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(25,10,12,0.6)";
    ctx.strokeText(MICRA_SIGNWRITING.fleetNumber, 0, 0);
    ctx.fillText(MICRA_SIGNWRITING.fleetNumber, 0, 0);
    ctx.restore();
    ctx.font = "bold 50px Impact, 'Arial Black', sans-serif";
    ctx.fillText(MICRA_SIGNWRITING.route, 256, 236);
  });
}

function plateTexture(): CanvasTexture {
  return canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = MICRA_PLATE.background;
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = MICRA_PLATE.text;
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = MICRA_PLATE.text;
    ctx.textAlign = "center";
    ctx.font = "bold 11px Arial, sans-serif";
    ctx.fillText(MICRA_PLATE.state, 128, 14);
    ctx.font = "bold 34px 'Arial Narrow', Arial, sans-serif";
    ctx.fillText(MICRA_PLATE.number, 128, 46);
    ctx.font = "bold 9px Arial, sans-serif";
    ctx.fillText(MICRA_PLATE.slogan, 128, 59);
  });
}

function stickerTexture(text: string): CanvasTexture {
  return canvasTexture(512, 64, (ctx) => {
    ctx.textAlign = "center";
    ctx.font = "900 40px Impact, 'Arial Black', sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#101010";
    ctx.strokeText(text, 256, 48);
    ctx.fillStyle = "#ffd21f";
    ctx.fillText(text, 256, 48);
  });
}

/**
 * The procedural Micra taxi. Swap for a .glb later by keeping the props and
 * the MicraRig contract. Origin on the ground under the middle of the car, -Z forward.
 */
export function MicraModel({ passengers = 0, luggageKg = 0, showDriver = true, sticker = MICRA_DEFAULT_STICKER, castShadow = true, ref }: Props) {
  const geo = useMemo(() => buildMicraGeometry({ passengers, showDriver, luggageKg }), [passengers, showDriver, luggageKg]);
  useEffect(
    () => () => {
      for (const g of [geo.paint, geo.trim, geo.glass, geo.lamps, geo.brake, geo.interior, geo.wheel]) g.dispose();
    },
    [geo],
  );

  const parts = useMemo(() => {
    const steering = buildSteeringWheel();
    const needle = buildNeedle();
    const d = geo.decals;
    const decals = {
      doorLeft: quadGeometry(d.doorLeft),
      doorRight: quadGeometry(d.doorRight),
      plateFront: quadGeometry(d.plateFront),
      plateRear: quadGeometry(d.plateRear),
      sticker: quadGeometry(d.sticker),
      mirror: quadGeometry(d.mirror, true),
    };
    return { steering, needle, decals };
    // Decal surfaces don't depend on load; build once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      parts.steering.dispose();
      parts.needle.dispose();
      Object.values(parts.decals).forEach((g) => g.dispose());
    },
    [parts],
  );

  const mats = useMemo(() => {
    const paint = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12, side: DoubleSide });
    const matte = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: DoubleSide });
    const glass = new MeshStandardMaterial({
      color: C.glass,
      roughness: 0.05,
      metalness: 0.3,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: DoubleSide,
    });
    const lamps = new MeshStandardMaterial({ vertexColors: true, roughness: 0.2, emissive: new Color("#fff4dc"), emissiveIntensity: 0.12, side: DoubleSide });
    const brake = new MeshStandardMaterial({ vertexColors: true, roughness: 0.3, emissive: new Color(C.brakeLight), emissiveIntensity: 0.1, side: DoubleSide });
    const decal = (map: Texture, extra: Partial<MeshStandardMaterial> = {}) =>
      Object.assign(new MeshStandardMaterial({ map, transparent: true, alphaTest: 0.05, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }), extra);
    const sign = signwritingTexture();
    const plate = plateTexture();
    const mirror = new MeshBasicMaterial({ color: "#39434d" });
    return { paint, matte, glass, lamps, brake, sign, plate, mirror, signMat: decal(sign), plateMat: decal(plate, { transparent: false }) };
  }, []);
  useEffect(
    () => () => {
      for (const m of [mats.paint, mats.matte, mats.glass, mats.lamps, mats.brake, mats.mirror, mats.signMat, mats.plateMat]) m.dispose();
      mats.sign.dispose();
      mats.plate.dispose();
    },
    [mats],
  );

  const stickerMat = useMemo(() => {
    if (!sticker) return null;
    const map = stickerTexture(sticker);
    return new MeshStandardMaterial({ map, transparent: true, alphaTest: 0.05, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
  }, [sticker]);
  useEffect(
    () => () => {
      stickerMat?.map?.dispose();
      stickerMat?.dispose();
    },
    [stickerMat],
  );

  const lean = useRef<Group>(null);
  const steering = useRef<Group>(null);
  const needle = useRef<Group>(null);
  const mirrorMesh = useRef<Mesh>(null);
  const pivots = useRef<(Group | null)[]>([]);
  const squashes = useRef<(Group | null)[]>([]);
  const spins = useRef<(Group | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      wheels: geo.pivots.wheels.map((hardPoint, i) => ({ pivot: pivots.current[i]!, squash: squashes.current[i]!, spin: spins.current[i]!, hardPoint })),
      lean: lean.current!,
      steeringWheel: steering.current!,
      speedoNeedle: needle.current!,
      brakeLights: mats.brake,
      mirror: mats.mirror,
      mirrorMesh: mirrorMesh.current!,
    }),
    [geo, mats],
  );

  const p = geo.pivots;
  return (
    <group>
      <group ref={lean} position={[0, LEAN_Y, 0]}>
        <group position={[0, -LEAN_Y, 0]}>
          <mesh geometry={geo.paint} material={mats.paint} castShadow={castShadow} receiveShadow />
          <mesh geometry={geo.trim} material={mats.matte} castShadow={castShadow} />
          <mesh geometry={geo.interior} material={mats.matte} />
          <mesh geometry={geo.lamps} material={mats.lamps} />
          <mesh geometry={geo.brake} material={mats.brake} />
          <mesh geometry={parts.decals.doorLeft} material={mats.signMat} />
          <mesh geometry={parts.decals.doorRight} material={mats.signMat} />
          <mesh geometry={parts.decals.plateFront} material={mats.plateMat} />
          <mesh geometry={parts.decals.plateRear} material={mats.plateMat} />
          <mesh ref={mirrorMesh} geometry={parts.decals.mirror} material={mats.mirror} />
          {stickerMat && <mesh geometry={parts.decals.sticker} material={stickerMat} renderOrder={2} />}
          <group position={p.steeringWheel} rotation={[p.steeringTilt, 0, 0]}>
            <group ref={steering}>
              <mesh geometry={parts.steering} material={mats.matte} />
            </group>
          </group>
          <group position={p.speedo}>
            <group ref={needle}>
              <mesh geometry={parts.needle} material={mats.lamps} />
            </group>
          </group>
          {/* Glass last among the body parts: transparent, so the seat covers show through. */}
          <mesh geometry={geo.glass} material={mats.glass} renderOrder={1} />
        </group>
      </group>
      {p.wheels.map((hp, i) => (
        <group key={i} ref={(g) => void (pivots.current[i] = g)} position={hp}>
          <group ref={(g) => void (squashes.current[i] = g)}>
            {/* Left wheels are turned round so the steel wheel faces out. */}
            <group rotation={[0, i % 2 === 0 ? Math.PI : 0, 0]}>
              <group ref={(g) => void (spins.current[i] = g)}>
                <mesh geometry={geo.wheel} material={mats.matte} castShadow={castShadow} />
              </group>
            </group>
          </group>
        </group>
      ))}
    </group>
  );
}
