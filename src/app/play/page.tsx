import type { Metadata } from "next";
import { PlayClient } from "./PlayClient";

export const metadata: Metadata = {
  title: "Play · Micra Ibadan",
};

export default function PlayPage() {
  return <PlayClient />;
}
