@AGENTS.md

# Micra Ibadan

Micra Ibadan is an open world browser driving game set in real Ibadan, Oyo State, Nigeria. You drive an old Nissan Micra shared taxi owned by your oga. You load at the garage, squeeze passengers in, collect fares and climb Ibadan's hills. Along the way you deal with garage touts, OYRTMA, VIO, FRSC and the police, and at the end of the day you make the daily delivery to the oga. The map, roads and elevation come from real data, so the city should feel like Ibadan and not a generic town.

### The Ibadan Micra taxi

- Nissan Micra K11 hatchback, old and battered, on black steel wheels
- Livery: wine/maroon body, cream roof and window pillars, black bumpers and side rub strip. The fleet number and route are hand-painted on the front door (e.g. "1542 AKINYELE") under a garage badge. Oyo plates.
- **5 paying passengers:** 2 squeezed into the front passenger seat and 3 in the back. Capacity and colours live in `src/game/vehicles/micraSpec.ts`.

## Stack

- Next.js (App Router, TypeScript, `src/`), Tailwind v4, ESLint, **pnpm**
- three, @react-three/fiber v9, @react-three/drei v10, @react-three/rapier v2 (physics)
- zustand (stores), howler (audio), r3f-perf (dev only)
  - `patches/r3f-perf@7.2.3.patch` strips a broken source map from its embedded font. Without it, Turbopack dev panics with "invalid utf-8" on `/play`. Re-check it if you upgrade r3f-perf.
- Python for offline map tooling in `pipeline/`

## Folders

| Path | Contents |
| --- | --- |
| `src/app` | Routes only: `/` menu, `/play` game, `/garage`, `/leaderboard` |
| `src/game/core` | Game loop, clock, event bus (`events.ts`), system registry |
| `src/game/world` | Canvas root, map chunks, roads, buildings, terrain, projection constants |
| `src/game/vehicles` | Player and traffic vehicles |
| `src/game/npc` | Passengers, touts, officers, pedestrians |
| `src/game/systems` | Gameplay systems: `economy/`, `enforcement/`, `passengers/` |
| `src/game/ui` | HUD components (DOM overlay) |
| `src/game/store` | zustand stores |
| `pipeline/` | Python map tooling (OSM + DEM to chunks) |
| `public/chunks` | Local chunk output for dev |

## Rules

- **Never run three.js on the server.** `/play` loads `GameCanvas` via `next/dynamic` with `ssr: false` from a `'use client'` wrapper (`src/app/play/PlayClient.tsx`). Nothing under `src/app` may import `three`, `@react-three/*`, `r3f-perf` or `howler` directly.
- **Per-frame state never goes in React state.** Anything that changes every frame (speed, positions, timers) lives in refs, in plain module objects (`gameClock`), or in zustand transient updates: write with `useStore.setState`, read with `useStore.subscribe` or `getState()` in `useFrame`. Only select store values in components when they change at gameplay speed (cash, passenger count).
- **Systems talk through the event bus** (`src/game/core/events.ts`). A system in `src/game/systems/*` must not import another system. Add a typed event to `GameEvents` instead. Systems expose `start…System(): () => void` and are started from `src/game/systems/index.ts`.
- **World units are metres, +Y up.** +X = east, −Z = north (three.js is right-handed). Vehicle forward is −Z in local space.
- **Real elevation.** Y comes from terrain data (DEM). Never fake hills with noise once chunk data exists.
- **Map data uses a local metric projection centred on Dugbe.** It is transverse Mercator, and the origin is defined in `src/game/world/projection.ts`, which must stay in sync with `pipeline/`.

### Projection origin: Dugbe

- Dugbe junction at Iyaganku Road / Fajuyi Road / Onireke Road, beside Cocoa House and ShopRite Dugbe
- OSM node **168734026**: **lat 7.3903934, lon 3.8794116** (WGS84)
- `+proj=tmerc +lat_0=7.3903934 +lon_0=3.8794116 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`
- Game coordinates: `x = easting`, `z = -northing`, `y = elevation − elevation(origin)`

OSM does not tag a `junction=roundabout` at Dugbe. The nearest one it tags is the Magazine Rd / Dick Rd roundabout (way 606902218), about 600 m NW. The origin was therefore taken as the node where Iyaganku, Fajuyi and Onireke roads meet. Don't change it once chunk data exists, because every chunk would need regenerating.

## Commands

```sh
pnpm install          # install deps
pnpm dev              # dev server → http://localhost:3000/play  (add ?debug to draw physics colliders)
pnpm lint             # ESLint
pnpm build            # production build (also checks nothing three-related runs server-side)

# map pipeline (not implemented yet, see pipeline/README.md)
python3 -m venv pipeline/.venv && source pipeline/.venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pipeline.build --out public/chunks
```
