import { Button95 } from "./Button95";

export interface Tab95 {
  id: string;
  label: string;
}

interface Tabs95Props {
  tabs: Tab95[];
  activeId: string;
  onChange: (id: string) => void;
}

export function Tabs95({ tabs, activeId, onChange }: Tabs95Props) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <Button95
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          pressed={tab.id === activeId}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </Button95>
      ))}
    </div>
  );
}
