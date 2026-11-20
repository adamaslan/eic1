import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Window } from "~/ui95/Window";
import { Button95 } from "~/ui95/Button95";
import { DirectoryController, searchCards, type DirectoryCard } from "~/platform/discover-controller";

export function DiscoverDirectory({ controller }: { controller: DirectoryController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DirectoryCard | null>(null);
  const [editing, setEditing] = useState(false);
  // Deliberately blank. Existing private profile data is never copied into a public card.
  const [name, setName] = useState(""); const [handle, setHandle] = useState(""); const [bio, setBio] = useState("");
  useEffect(() => { void controller.load(); }, [controller]);
  const cards = searchCards(state.cards, query);
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-3 text-[12px]">
      <Window title="Discover">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h1 className="text-lg font-bold">Find your people</h1><p>Browse people who chose to be here.</p></div>
            <Link className="inline-flex min-h-[44px] items-center underline" to="/connections">Friends &amp; chats</Link>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border border-[var(--w95-muted)] bg-white p-3">
            <div><p className="font-bold">{state.visibility === "listed" ? "You are in Discover" : state.visibility === "hidden" ? "You are hidden from Discover" : "Visibility not confirmed"}</p><p>Hiding keeps your friends and chats.</p></div>
            {state.visibility === "listed" || state.visibility === "unknown" ? (
              <Button95 disabled={!state.ready || state.busy} onClick={() => { void controller.hide(); }}>Hide me from Discover</Button95>
            ) : <Button95 disabled={!state.ready || state.busy} onClick={() => setEditing(!editing)}>Show me in Discover</Button95>}
          </div>
          {editing && state.visibility === "hidden" && <form className="flex flex-col gap-2 border border-[var(--w95-muted)] p-3" onSubmit={(event) => { event.preventDefault(); void controller.publish({ name, handle, bio }); }}>
            <h2 className="font-bold">Choose your public card</h2>
            <p>Only the name, handle and bio you enter here are listed. Your private profile is not copied.</p>
            <label className="flex flex-col gap-1">Public name<input className="min-h-[44px] bg-white px-2 text-black" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="flex flex-col gap-1">Public handle<input className="min-h-[44px] bg-white px-2 text-black" required maxLength={30} value={handle} onChange={(e) => setHandle(e.target.value)} /></label>
            <label className="flex flex-col gap-1">Short bio (optional)<textarea className="min-h-[66px] bg-white p-2 text-black" maxLength={160} value={bio} onChange={(e) => setBio(e.target.value)} /></label>
            <div className="flex gap-2"><Button95 type="submit" disabled={state.busy}>List this card</Button95><Button95 type="button" disabled={state.busy} onClick={() => setEditing(false)}>Cancel</Button95></div>
          </form>}
          {state.ownCard && <p className="border border-[var(--w95-muted)] bg-white p-2">Your listed card: <b>{state.ownCard.name}</b> @{state.ownCard.handle}{state.ownCard.bio && ` · ${state.ownCard.bio}`}</p>}
          {state.error && <p role="alert" className="border border-red-700 bg-[#fff0f0] p-2 text-black">{state.error}</p>}
          {state.notice && <p role="status">{state.notice}</p>}
          {!state.ready && !state.busy && <Button95 onClick={() => { void controller.load(); }}>Try again</Button95>}
          <label className="flex flex-col gap-1 font-bold">Search people<input className="min-h-[44px] w-full bg-white px-3 font-normal text-black" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, handle or interest" disabled={!state.ready} /></label>
          {state.busy && <p role="status">Working...</p>}
          {state.ready && state.incoming.length > 0 && (
            <section className="flex flex-col gap-2 border border-[var(--w95-muted)] p-2" aria-label="Incoming requests">
              <p className="font-bold">{state.incoming.length} {state.incoming.length === 1 ? "person wants" : "people want"} to connect with you</p>
              {state.incoming.map((id) => (
                <div key={id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 break-all">{cards.find((card) => card.id === id)?.name ?? "Someone on Discover"}</span>
                  <Button95 disabled={state.busy} onClick={() => { void controller.accept(id); }}>Accept</Button95>
                  <Button95 disabled={state.busy} onClick={() => { void controller.decline(id); }}>Decline</Button95>
                </div>
              ))}
              <p className="text-[12px] text-[var(--w95-muted)]">Accepting shares your connect with them and imports theirs. Nothing is shared until you accept.</p>
            </section>
          )}
          {state.ready && <p>{cards.length} {cards.length === 1 ? "person" : "people"}{query.trim() ? " found" : " to discover"}</p>}
          {state.ready && cards.length === 0 && <p>No people match. Try a different name or interest.</p>}
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="People to discover">
            {cards.map((card) => <li key={card.id} className="flex min-w-0 flex-col gap-2 border border-[var(--w95-muted)] bg-white p-3">
              <div className="flex items-center gap-3"><span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center bg-[#dcd3ef] text-lg font-bold text-black">{card.name.slice(0, 1)}</span><div className="min-w-0 break-words"><h2 className="font-bold">{card.name}</h2><p>@{card.handle}</p></div></div>
              <p className="min-h-9 break-words">{card.bio || "No bio yet."}</p>
              <Button95 onClick={() => setSelected(card)}>View {card.name}</Button95>
            </li>)}
          </ul>
        </div>
      </Window>
      {selected && <Window title={`About ${selected.name}`}><section aria-label={`Profile for ${selected.name}`} className="flex flex-col gap-3">
        <h2 className="text-base font-bold">{selected.name} <span className="text-[12px] font-normal">@{selected.handle}</span></h2><p className="break-words">{selected.bio || "No bio yet."}</p><p>Adding sends a request, not a message. No chat opens until both people agree.</p>
        <div className="flex flex-wrap gap-2"><Button95 disabled={state.busy || state.requested.includes(selected.id)} onClick={() => { void controller.request(selected.id); }}>{state.requested.includes(selected.id) ? "Request sent" : `Add ${selected.name}`}</Button95><Button95 onClick={() => setSelected(null)}>Close profile</Button95></div>
      </section></Window>}
    </div>
  );
}
