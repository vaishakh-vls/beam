import { HIDE, type Entry } from "../entry";
import { bestScore } from "../fuzzy";
import { lazyBundle } from "../lazy";
import type * as EmojiBundle from "../lazy/emoji";
import { JsonStore } from "../store";
import { copyText, pasteText, pasteVerb } from "../system";

type EmojiInfo = EmojiBundle.EmojiInfo;

const emoji = lazyBundle<typeof EmojiBundle>("emoji");
const recent = new JsonStore<{ emoji: string[] }>("emoji-recent.json", () => ({ emoji: [] }));

function markUsed(emoji: string): void {
  recent.data.emoji = [emoji, ...recent.data.emoji.filter((e) => e !== emoji)].slice(0, 24);
  recent.save();
}

export function emojiSections(query: string, hide: () => void): Array<{ title: string; entries: Entry[] }> {
  const q = query.trim();
  if (q) {
    const matches = emoji().all.map(([symbol, info]) => ({
      symbol,
      info,
      score: bestScore(q, [info.name, info.slug.replaceAll("_", " "), info.group]),
    }))
      .filter((m) => m.score >= 300)
      .sort((a, b) => b.score - a.score)
      .slice(0, 160);
    return [{ title: "Results", entries: matches.map((m) => emojiEntry(m.symbol, m.info, hide)) }];
  }

  const sections: Array<{ title: string; entries: Entry[] }> = [];
  const { all, lookup } = emoji();
  const recents = recent.data.emoji.filter((e) => lookup[e]);
  if (recents.length) {
    sections.push({ title: "Recently Used", entries: recents.map((e) => emojiEntry(e, lookup[e], hide)) });
  }
  const groups = new Map<string, Entry[]>();
  for (const [symbol, info] of all) {
    if (!groups.has(info.group)) groups.set(info.group, []);
    groups.get(info.group)!.push(emojiEntry(symbol, info, hide));
  }
  for (const [title, entries] of groups) sections.push({ title, entries });
  return sections;
}

function emojiEntry(emoji: string, info: EmojiInfo, hide: () => void): Entry {
  return {
    id: `emoji:${emoji}`,
    title: info.name,
    icon: emoji,
    actions: [
      {
        id: "paste",
        title: `${pasteVerb()} Emoji`,
        shortcut: "↵",
        run: async () => {
          markUsed(emoji);
          await pasteText(emoji, hide);
          return HIDE;
        },
      },
      {
        id: "copy",
        title: "Copy Emoji",
        shortcut: "Ctrl+↵",
        run: () => {
          markUsed(emoji);
          copyText(emoji);
          return HIDE;
        },
      },
      {
        id: "copy-name",
        title: "Copy Name",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(info.name);
          return { type: "stay", toast: "Name copied" };
        },
      },
    ],
  };
}
