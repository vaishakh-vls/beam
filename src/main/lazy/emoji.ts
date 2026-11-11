// The emoji list, built as its own bundle (see ../lazy.ts): it loads when the
// emoji picker first opens.
import emojiData from "unicode-emoji-json/data-by-emoji.json";

export interface EmojiInfo {
  name: string;
  slug: string;
  group: string;
}

export const lookup = emojiData as Record<string, EmojiInfo>;
export const all = Object.entries(lookup);
