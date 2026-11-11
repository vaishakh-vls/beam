// mathjs for the calculator, built as its own bundle (see ../lazy.ts): over a
// megabyte of code that only loads with the first sum typed.
import { create, all } from "mathjs";

const math = create(all, {});
// Expressions come from the search box, so turn off everything that could
// define functions or touch anything beyond arithmetic and unit conversion.
export const evaluate: (expression: string) => unknown = math.evaluate.bind(math);
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

export function format(value: unknown): string {
  return math.format(value as never, { precision: 10 });
}
