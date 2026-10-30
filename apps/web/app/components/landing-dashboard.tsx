import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { CATEGORIES, MAX_KEYWORDS, SLOT_IDS, timeAgo, type Category, type Item, type Settings, type SlotId } from "@veil/core";
import { addNote, selectFeed, selectPicks } from "@veil/features";
import { Button95 } from "~/ui95/Button95";
import { Window } from "~/ui95/Window";
import { ListingRow, PhotoCard } from "~/components/cards";
import { useSessionStore } from "~/platform/session";
import { useSocial, type Social } from "~/platform/use-social";
import { newItemId } from "~/platform/vault-service";

const SLOT_LABELS: Record<SlotId, string> = {
  feed: "Feed",
  picks: "Marketplace picks",
  messages: "Messages",
  "more-feed": "More feed",
};
const POSITION_NAMES = ["Main box", "Top right box", "Bottom right box"];
const PICK_CATEGORIES = CATEGORIES.filter((category) => category !== "moments");
const inputClass = "w-full bg-white px-1.5 py-1 text-[12px] text-[#0a0a0a] outline-none";

// The signed-in landing: the feed up front, three picks from the user's preferences, and boxes that can trade places.
export function LandingDashboard() {
  const vault = useSessionStore((state) => state.vault);
  const social = useSocial(vault);
  const { items, settings, update } = social;

  if (items.status === "loading") return <p className="text-[12px] text-white">Opening your desktop…</p>;
  if (items.status === "error") return <p role="alert" className="text-[12px] text-white">{items.message}</p>;

  function swap(position: number, next: SlotId) {
    if (!social.settingsReady) return;
    const slots = [...settings.slots] as Settings["slots"];
    const other = slots.indexOf(next);
    if (other !== -1 && other !== position) slots[other] = slots[position]!;
    slots[position] = next;
    void update({ ...settings, slots });
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {settings.slots.map((slot, position) => (
        <div key={position} className={position === 0 ? "md:col-span-2 md:row-span-2" : ""}>
          <Window title={SLOT_LABELS[slot]}>
            <div className="flex flex-col gap-2 text-[12px]">
              <label className="flex items-center gap-1 text-[11px] text-[#404040]">
                <span>{POSITION_NAMES[position]} shows</span>
                <select
                  disabled={!social.settingsReady}
                  value={slot}
                  onChange={(e) => swap(position, e.target.value as SlotId)}
                  className="bg-white px-1 py-0.5 text-[11px] text-[#0a0a0a]"
                >
                  {SLOT_IDS.map((id) => (
                    <option key={id} value={id}>{SLOT_LABELS[id]}</option>
                  ))}
                </select>
              </label>
              <Box slot={slot} large={position === 0} social={social} />
            </div>
          </Window>
        </div>
      ))}
    </div>
  );
}

function Box({ slot, large, social }: { slot: SlotId; large: boolean; social: Social }) {
  const { items, settings } = social;
  if (items.status !== "ready") return null;
  switch (slot) {
    case "feed":
      return <FeedBox items={items.items} count={large ? 6 : 3} large={large} />;
    case "more-feed":
      return <FeedBox items={items.items} count={12} large={large} />;
    case "picks":
      return <PicksBox items={items.items} social={social} settings={settings} />;
    case "messages":
      return <MessagesBox social={social} />;
  }
}

function FeedBox({ items, count, large }: { items: Item[]; count: number; large: boolean }) {
  const photos = selectFeed(items, "").slice(0, count);
  const now = new Date();
  if (photos.length === 0) {
    return (
      <p>
        No moments yet. <Link to="/compose" className="text-[#0000cc] underline">Post one</Link>, or{" "}
        <Link to="/connections" className="text-[#0000cc] underline">import a friend's share file</Link>.
      </p>
    );
  }
  return (
    <>
      <ul className={`grid gap-2 ${large ? "grid-cols-2 lg:grid-cols-3" : "grid-cols-1"}`}>
        {photos.map((item) => (
          <li key={item.id}>
            <PhotoCard item={item} now={now} height={large ? 140 : 90} />
          </li>
        ))}
      </ul>
      <Link to="/feed" className="text-[#0000cc] underline">Open the full feed</Link>
    </>
  );
}

function PicksBox({ items, social, settings }: { items: Item[]; social: Social; settings: Settings }) {
  const [editing, setEditing] = useState(false);
  const picks = selectPicks(items, settings);
  const now = new Date();
  const hasPrefs = settings.categories.length > 0 || settings.keywords.length > 0;
  return (
    <>
      {editing && social.settingsReady ? (
        <PicksEditor settings={settings} onSave={async (next) => { await social.update(next); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p className="text-[11px] text-[#404040]">
            {hasPrefs
              ? `Matched to ${[...settings.categories, ...settings.keywords].join(", ")}.`
              : "Newest listings. Set your picks to tune these."}
          </p>
          {picks.length === 0 ? (
            <p>No listings yet. <Link to="/compose" className="text-[#0000cc] underline">Add one</Link>.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {picks.map((item) => (
                <li key={item.id}>
                  <ListingRow item={item} now={now} />
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button95 disabled={!social.settingsReady} onClick={() => setEditing(true)}>Your picks…</Button95>
            <Link to="/market" className="self-center text-[#0000cc] underline">All listings</Link>
          </div>
        </>
      )}
    </>
  );
}

function PicksEditor({ settings, onSave, onCancel }: { settings: Settings; onSave: (next: Settings) => Promise<void>; onCancel: () => void }) {
  const [categories, setCategories] = useState<Category[]>(settings.categories);
  const [keywords, setKeywords] = useState(settings.keywords.join(", "));
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ ...settings, categories, keywords: keywords.split(",") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
        <legend className="mb-1 font-bold">Categories you like</legend>
        {PICK_CATEGORIES.map((category) => (
          <label key={category} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={categories.includes(category)}
              onChange={(e) =>
                setCategories((current) => (e.target.checked ? [...current, category] : current.filter((c) => c !== category)))
              }
            />
            {category}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className="font-bold">Keywords (up to {MAX_KEYWORDS}, comma separated)</span>
        <input className={inputClass} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="steel, film, vintage" />
      </label>
      <div className="flex gap-2">
        <Button95 type="submit" disabled={saving}>Save picks</Button95>
        <Button95 onClick={onCancel} disabled={saving}>Cancel</Button95>
      </div>
    </form>
  );
}

function MessagesBox({ social }: { social: Social }) {
  const vault = useSessionStore((state) => state.vault);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const now = new Date();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!vault || !text.trim() || busy) return;
    setBusy(true);
    try {
      await addNote(vault, text, { newId: newItemId, now: new Date() });
      setText("");
      social.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-[11px] text-[#404040]">Notes to yourself, plus news from share files you import. Nobody else can write here.</p>
      <form onSubmit={submit} className="flex gap-1">
        <input className={inputClass} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Write a note" aria-label="New note" />
        <Button95 type="submit" disabled={busy || !text.trim()}>Add</Button95>
      </form>
      {social.notes.length === 0 ? (
        <p>No messages yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {social.notes.slice(0, 6).map((note) => (
            <li key={note.id} className="bg-white px-1.5 py-1">
              <span className="text-[#404040]">{timeAgo(note.createdAt, now)} · </span>
              {note.text}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
