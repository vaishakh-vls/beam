import emojiData from "unicode-emoji-json/data-by-emoji.json";
import { HIDE, type Entry } from "../entry";
import { bestScore } from "../fuzzy";
import { JsonStore } from "../store";
import { copyText, pasteText, pasteVerb } from "../system";

interface EmojiInfo {
  name: string;
  slug: string;
  group: string;
}

const ALL = Object.entries(emojiData as Record<string, EmojiInfo>);
const recent = new JsonStore<{ emoji: string[] }>("emoji-recent.json", () => ({ emoji: [] }));

function markUsed(emoji: string): void {
  recent.data.emoji = [emoji, ...recent.data.emoji.filter((e) => e !== emoji)].slice(0, 24);
  recent.save();
}

export function emojiSections(query: string, hide: () => void): Array<{ title: string; entries: Entry[] }> {
  const q = query.trim();
  if (q) {
    const matches = ALL.map(([emoji, info]) => ({
      emoji,
      info,
      score: bestScore(q, [info.name, info.slug.replaceAll("_", " "), info.group]),
    }))
      .filter((m) => m.score >= 300)
      .sort((a, b) => b.score - a.score)
      .slice(0, 160);
    return [{ title: "Results", entries: matches.map((m) => emojiEntry(m.emoji, m.info, hide)) }];
  }

  const sections: Array<{ title: string; entries: Entry[] }> = [];
  const lookup = emojiData as Record<string, EmojiInfo>;
  const recents = recent.data.emoji.filter((e) => lookup[e]);
  if (recents.length) {
    sections.push({ title: "Recently Used", entries: recents.map((e) => emojiEntry(e, lookup[e], hide)) });
  }
  const groups = new Map<string, Entry[]>();
  for (const [emoji, info] of ALL) {
    if (!groups.has(info.group)) groups.set(info.group, []);
    groups.get(info.group)!.push(emojiEntry(emoji, info, hide));
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
