import type { CcProvider } from "../types.ts";

export interface TabInfo {
  appType: string;
  count: number;
  hasCurrent: boolean;
}

export function buildTabs(
  providers: CcProvider[],
  preferredOrder?: string[],
): TabInfo[] {
  const map = new Map<string, TabInfo>();
  for (const p of providers) {
    const cur = map.get(p.appType) ?? {
      appType: p.appType,
      count: 0,
      hasCurrent: false,
    };
    cur.count++;
    if (p.isCurrentInCc) cur.hasCurrent = true;
    map.set(p.appType, cur);
  }

  const tabs = [...map.values()];
  const order = preferredOrder ?? [];
  const rank = (t: TabInfo): [number, number, string] => {
    const idx = order.indexOf(t.appType);
    return [idx >= 0 ? idx : 1000, t.hasCurrent ? 0 : 1, t.appType];
  };
  tabs.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0;
  });
  return tabs;
}

export function formatTabLabel(tab: TabInfo, active: boolean): string {
  const mark = active ? "● " : "";
  return `${mark}${tab.appType} ${tab.count}`;
}
