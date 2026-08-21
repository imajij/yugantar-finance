import { formatPaise } from "@/lib/money";

// ponytail: placeholder home. Replaced by the (app)/dashboard shell in M1.
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-display text-3xl text-lime">Yugaantar Finance &amp; Operations</h1>
      <p className="mt-3 text-text-soft">
        Foundation is up: schema, budget views, state machines, authorization, money.
      </p>
      <p className="tnum mt-6 text-text-muted">{formatPaise(12345600)}</p>
    </main>
  );
}
