import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Veil 95" }];
}

export default function Home() {
  return (
    <main className="min-h-screen bg-veil-bg p-4 font-sans text-veil-text">
      <h1 className="text-lg font-bold">Veil 95</h1>
      <p className="text-sm text-veil-muted">Scaffold running. Milestone M1 next.</p>
    </main>
  );
}
