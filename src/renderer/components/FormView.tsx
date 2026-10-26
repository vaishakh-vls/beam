import { useEffect, useRef, useState } from "react";
import type { FormField, FormSpec } from "../../shared/types";
import { hotkeyFromEvent } from "../keys";

interface Props {
  form: FormSpec;
  onSubmit: (values: Record<string, string>) => void;
}

export function FormView({ form, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.name, f.value ?? ""])),
  );
  const firstRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => firstRef.current?.focus(), [form.id]);

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  function onKeyDown(event: React.KeyboardEvent) {
    const inTextarea = (event.target as HTMLElement).tagName === "TEXTAREA";
    if (event.key === "Enter" && (event.ctrlKey || !inTextarea)) {
      event.preventDefault();
      onSubmit(values);
    }
  }

  return (
    <form className="form" onKeyDown={onKeyDown} onSubmit={(e) => e.preventDefault()}>
      {form.fields.map((field, i) => (
        <label key={field.name} className="form-field">
          <span className="form-label">
            {field.label}
            {field.optional && <span className="form-optional"> (optional)</span>}
          </span>
          <Field
            field={field}
            value={values[field.name]}
            onChange={(v) => set(field.name, v)}
            inputRef={i === 0 ? firstRef : undefined}
          />
          {field.hint && <span className="form-hint">{field.hint}</span>}
        </label>
      ))}
    </form>
  );
}

interface FieldProps {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.Ref<HTMLInputElement & HTMLTextAreaElement>;
}

function Field({ field, value, onChange, inputRef }: FieldProps) {
  if (field.type === "textarea") {
    return (
      <textarea
        ref={inputRef}
        rows={6}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === "hotkey") {
    return (
      <input
        ref={inputRef}
        className="hotkey-input"
        readOnly
        value={value}
        placeholder={field.placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return;
          if (e.key === "Escape" || e.key === "Tab") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
            onChange("");
            return;
          }
          const combo = hotkeyFromEvent(e);
          if (combo) onChange(combo);
        }}
      />
    );
  }
  return (
    <input
      ref={inputRef}
      type={field.type === "password" ? "password" : "text"}
      value={value}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
