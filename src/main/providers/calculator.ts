import { create, all } from "mathjs";
import type { Entry } from "../entry";
import { copyText, pasteText, pasteVerb } from "../system";

const math = create(all, {});
// Expressions come from the search box, so turn off everything that could
// define functions or touch anything beyond arithmetic and unit conversion.
const evaluate = math.evaluate.bind(math);
math.import(
  {
    import: () => {
      throw new Error("disabled");
    },
    createUnit: () => {
      throw new Error("disabled");
    },
    parse: () => {
      throw new Error("disabled");
    },
    simplify: () => {
      throw new Error("disabled");
    },
    derivative: () => {
      throw new Error("disabled");
    },
  },
  { override: true },
);

/** Does the text look like math/unit conversion rather than a word search? */
function looksLikeMath(query: string): boolean {
  if (!/\d/.test(query)) return false;
  return /[+\-*/^%()]|\b(to|in)\b|[a-z]+\s*$/i.test(query) || /^\s*[\d.]+\s*[a-z]/i.test(query);
}

function normalise(query: string): string {
  return query
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/gi, "($1/100)*$2");
}

function formatResult(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? value.toLocaleString("en-US") : Number(value.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 10 });
  }
  if (value && typeof value === "object" && "toString" in value) {
    const type = (value as { type?: string }).type;
    if (type === "Unit" || type === "BigNumber" || type === "Fraction" || type === "Complex") {
      return math.format(value as never, { precision: 10 });
    }
  }
  return null;
}

export function calculatorEntry(query: string, hide: () => void): Entry | null {
  const q = query.trim();
  if (!q || !looksLikeMath(q)) return null;
  let result: string | null = null;
  try {
    result = formatResult(evaluate(normalise(q)));
  } catch {
    return null;
  }
  if (result === null || result === q) return null;
  const plain = result.replace(/,/g, "");
  return {
    id: "calc",
    title: result,
    subtitle: q,
    icon: "🧮",
    accessory: "Calculator",
    actions: [
      {
        id: "copy",
        title: "Copy Answer",
        shortcut: "↵",
        run: () => {
          copyText(plain);
          return { type: "hide" };
        },
      },
      {
        id: "paste",
        title: `${pasteVerb()} Answer`,
        shortcut: "Ctrl+↵",
        run: async () => {
          await pasteText(plain, hide);
          return { type: "hide" };
        },
      },
      {
        id: "copy-expression",
        title: "Copy Expression and Answer",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(`${q} = ${plain}`);
          return { type: "hide" };
        },
      },
    ],
  };
}
