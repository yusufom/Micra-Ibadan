"use client";

import { useEffect, useRef } from "react";
import { gameEvents, type GameEventHandler, type GameEventName } from "./events";

/**
 * Subscribe a component to a game event for its lifetime. The latest handler
 * is always called, so callers do not need to memoise it.
 */
export function useGameEvent<K extends GameEventName>(name: K, handler: GameEventHandler<K>): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => gameEvents.on(name, (payload) => handlerRef.current(payload)), [name]);
}
