/**
 * Worked examples for the intent decision, carried in Jev's `state`.
 *
 * TypeSafe's state is where examples belong, and a short reply only reads as
 * a change request next to the exchange it answers. Each example is a
 * miniature thread — what the user said, what the agent answered, what the
 * user said back — and the choice it should produce. They are the everyday
 * phrasings the real sessions use, not the eval fixtures.
 */
export type IntentExample = {
  /** The exchange, oldest line first; each line is one side's turn. */
  thread: Array<{ user?: string; agent?: string }>;
  choice: "draw" | "edit" | "variant" | "ask";
};

export const examples: IntentExample[] = [
  // A complaint, then a yes: both ask for the same fix.
  {
    thread: [{ user: "kok antar frame nggak konsisten ya?" }],
    choice: "edit",
  },
  {
    thread: [
      { user: "kok antar frame nggak konsisten ya?" },
      { agent: "Iya, bodinya digambar ulang lalu bergeser 1px." },
      { user: "ya perbaiki dong!" },
    ],
    choice: "edit",
  },
  {
    thread: [
      { user: "kok antar frame nggak konsisten ya?" },
      { agent: "Iya, bodinya digambar ulang lalu bergeser 1px." },
      { user: "iya, samakan aja" },
    ],
    choice: "edit",
  },
  // A flaw named in one line is already a fix request.
  {
    thread: [
      { user: "buatkan komputer layar mati dan nyala" },
      { agent: "Sudah: dua frame, bodi dan layar." },
      { user: "layarnya kurang nyala" },
    ],
    choice: "edit",
  },
  // A plan the agent proposed, and the user's yes.
  {
    thread: [
      { user: "buatkan komputer tabung jadul" },
      { agent: "Rencana: frame layar-mati dan layar-nyala. Setuju?" },
      { user: "oke lanjut" },
    ],
    choice: "draw",
  },
  // Questions want an answer, not pixels.
  {
    thread: [
      { user: "buatkan komputer" },
      { agent: "Sudah, layar pakai #5a6a7a." },
      { user: "kenapa warnanya jadi lebih gelap?" },
    ],
    choice: "ask",
  },
  {
    thread: [{ user: "warna apa yang cocok untuk gambar ini?" }],
    choice: "ask",
  },
  {
    thread: [
      { user: "buatkan slime" },
      { user: "ini ada dua ide, menurutmu mana yang lebih bagus?" },
    ],
    choice: "ask",
  },
  // New pixels and new states.
  {
    thread: [{ user: "tolong bikin slime biru 32x32 dong" }],
    choice: "draw",
  },
  {
    thread: [{ user: "buatkan slime" }, { user: "buatkan pixel art seperti gambar ini" }],
    choice: "draw",
  },
  {
    thread: [{ user: "buatkan slime" }, { user: "tambahin frame lompat ya" }],
    choice: "variant",
  },
];
