import { defaultSpaceColor } from "@orca/shared";
import "./color-preset-picker.css";

export const workspaceColorPresets = [
  { name: "Sage", value: defaultSpaceColor },
  { name: "Slate", value: "#7f8998" },
  { name: "Teal", value: "#459c98" },
  { name: "Blue", value: "#648ac4" },
  { name: "Violet", value: "#9a7bc0" },
  { name: "Rose", value: "#c7788c" },
  { name: "Amber", value: "#b58b48" },
];

export function ColorPresetPicker({ color, onChange, disabled = false, label = "Dot color" }: {
  color: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  // Opening an older space/view must not silently replace its saved color.
  const choices = workspaceColorPresets.some(choice => choice.value.toLowerCase() === color.toLowerCase())
    ? workspaceColorPresets : [...workspaceColorPresets, { name: "Existing color", value: color }];
  return <fieldset className="color-preset-picker" disabled={disabled}>
    <legend>{label}</legend>
    {choices.map(choice => {
      const selected = color.toLowerCase() === choice.value.toLowerCase();
      return <button key={choice.value} type="button" aria-pressed={selected} onClick={() => onChange(choice.value)}>
        <span aria-hidden="true" className="color-preset-dot" style={{ backgroundColor: choice.value }} />
        <span>{choice.name}</span><span aria-hidden="true" className="color-preset-check">{selected ? "✓" : ""}</span>
      </button>;
    })}
  </fieldset>;
}
