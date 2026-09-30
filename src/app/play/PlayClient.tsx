"use client";

import dynamic from "next/dynamic";

// ssr: false keeps three.js, r3f and rapier out of the server entirely.
const GameCanvas = dynamic(() => import("@/game/world/GameCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center bg-black font-mono text-sm text-white/70">
      Loading Ibadan…
    </div>
  ),
});

export function PlayClient() {
  return <GameCanvas />;
}
