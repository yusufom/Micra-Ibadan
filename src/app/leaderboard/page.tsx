import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Leaderboard · Micra Ibadan",
};

export default function LeaderboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">Leaderboard</h1>
      <p className="text-foreground/70">Top daily takings across Ibadan. Coming soon.</p>
      <Link href="/" className="underline">
        Back to menu
      </Link>
    </main>
  );
}
