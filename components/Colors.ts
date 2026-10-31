// Per-channel color palettes, used both for WebGL line colors and channel-select buttons.

export const darkThemeColors = [
  "#38bdf8", // CH1 - sky
  "#a78bfa", // CH2 - violet
  "#fb7185", // CH3 - rose
  "#4ade80", // CH4 - green
  "#facc15", // CH5 - amber
  "#f472b6", // CH6 - pink
];

export const lightThemeColors = [
  "#0284c7",
  "#7c3aed",
  "#e11d48",
  "#16a34a",
  "#ca8a04",
  "#db2777",
];

// Dedicated palette for the accelerometer (X/Y/Z) traces, kept visually
// distinct from the bioamp channel colors so the two plots never get confused.
export const accelColors: Record<"light" | "dark", string[]> = {
  dark: ["#f97316", "#22d3ee", "#eab308"],
  light: ["#c2410c", "#0e7490", "#a16207"],
};

export function getCustomColor(index: number, theme: "light" | "dark"): string {
  const colors = theme === "dark" ? darkThemeColors : lightThemeColors;
  return colors[index % colors.length];
}
