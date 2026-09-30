import Link from "next/link";

const links = [
  { href: "/play", label: "Play", hint: "Load at the garage and hit the road" },
  { href: "/garage", label: "Garage", hint: "Your Micra and the oga's account" },
  { href: "/leaderboard", label: "Leaderboard", hint: "Best daily takings" },
];

export default function MenuPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 p-8">
      <div>
        <h1 className="text-4xl font-bold tracking-tight">Micra Ibadan</h1>
        <p className="mt-2 text-foreground/70">Shared taxi. Seven hills. One oga waiting for his money.</p>
      </div>
      <nav className="flex flex-col gap-3">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-lg border border-foreground/15 px-5 py-4 transition-colors hover:bg-foreground/5"
          >
            <div className="font-semibold">{l.label}</div>
            <div className="text-sm text-foreground/60">{l.hint}</div>
          </Link>
        ))}
      </nav>
    </main>
  );
}
