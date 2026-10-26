import type { FormSpec, RunResult } from "../shared/types";
import { newId } from "./store";

type SubmitHandler = (values: Record<string, string>) => RunResult | Promise<RunResult>;

const handlers = new Map<string, SubmitHandler>();

/** Shows a form in the launcher; `onSubmit` runs with the entered values. */
export function showForm(spec: Omit<FormSpec, "id">, onSubmit: SubmitHandler): RunResult {
  const id = newId();
  // Only the most recent forms are kept; abandoned ones are dropped.
  if (handlers.size > 20) handlers.delete(handlers.keys().next().value!);
  handlers.set(id, onSubmit);
  return { type: "form", form: { ...spec, id } };
}

export async function submitForm(id: string, values: Record<string, string>): Promise<RunResult> {
  const handler = handlers.get(id);
  if (!handler) return { type: "error", message: "This form has expired. Please open it again." };
  for (const [key, value] of Object.entries(values)) values[key] = value ?? "";
  const result = await handler(values);
  if (result.type !== "error") handlers.delete(id);
  return result;
}
