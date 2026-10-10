export type DrawIntent = "draw" | "edit" | "variant" | "clarify";

const vague =
  /^(gambar|buat|make|draw)?\s*(sesuatu|something|anything|ini|itu)?[.!?\s]*$/i;
const variantWords =
  /\b(kiri|kanan|left|right|lari|jalan|run|walk|idle|hadap|facing|state|varian|variant)\b/i;

export function decideFromPrompt(prompt: string): {
  intent: DrawIntent;
  confidence: number;
  question?: string;
} {
  const text = prompt.trim();
  if (text.length < 8 || vague.test(text)) {
    return {
      intent: "clarify",
      confidence: 0.9,
      question:
        "What should the pixel asset show, and about how many pixels wide should it be?",
    };
  }
  if (variantWords.test(text)) return { intent: "variant", confidence: 0.8 };
  if (/\b(ubah|edit|fix|perbaiki|warnai|recolor)\b/i.test(text))
    return { intent: "edit", confidence: 0.75 };
  return { intent: "draw", confidence: 0.7 };
}
