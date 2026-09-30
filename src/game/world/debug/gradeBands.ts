/** Road grade bands (%) and colours for the G overlay and its DOM legend. */
export const GRADE_BANDS: { max: number; color: string; label: string }[] = [
  { max: 3, color: "#2ecc71", label: "< 3%" },
  { max: 6, color: "#b5e61d", label: "3–6%" },
  { max: 9, color: "#f1c40f", label: "6–9%" },
  { max: 12, color: "#e67e22", label: "9–12%" },
  { max: 16, color: "#e74c3c", label: "12–16%" },
  { max: Infinity, color: "#d633ff", label: "≥ 16%" },
];
