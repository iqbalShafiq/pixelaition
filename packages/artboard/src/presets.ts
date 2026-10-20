import type { FormatPreset, Rect, Zone } from "./types.js";

/**
 * Platform specifications change without a release note. Every preset carries
 * the page it came from and the day it was checked, and the UI prints both.
 * Formats marked `official: false` are industry-standard values the platform
 * does not publish as a hard requirement; they are editable, not doctrine.
 */
const CHECKED = "2026-10-20";

function zone(
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Zone {
  return { id, label, x, y, width, height };
}

function inset(width: number, height: number, percent: number): Rect {
  const x = Math.round(width * percent);
  const y = Math.round(height * percent);
  return { x, y, width: width - x * 2, height: height - y * 2 };
}

function safe(width: number, height: number, percent = 0.05): Zone {
  const rect = inset(width, height, percent);
  return { id: "safe", label: "Safe area", ...rect };
}

function profilePreset(input: {
  id: string;
  platform: string;
  label: string;
  size: number;
  source: string;
  official?: boolean;
  notes: string[];
}): FormatPreset {
  const rect = inset(input.size, input.size, 0.1);
  return {
    id: input.id,
    platform: input.platform,
    group: "profile",
    label: input.label,
    width: input.size,
    height: input.size,
    pixelUnit: 4,
    minTextSize: 0,
    maxBytes: 8_000_000,
    shape: "circle",
    safeZones: [{ id: "circle", label: "Circle crop", ...rect }],
    crops: [],
    exclusions: [],
    defaultTemplate: "profile-mark",
    notes: [
      "The platform crops this square to a circle; keep the mark inside the circle.",
      "A profile picture is a mark, not a poster: no small copy.",
      ...input.notes,
    ],
    source: input.source,
    verifiedAt: CHECKED,
    official: input.official ?? false,
  };
}

const FACEBOOK_HELP = "https://www.facebook.com/help/125379114252045";
const INSTAGRAM_PHOTO = "https://help.instagram.com/1631821640426723";
const INSTAGRAM_REELS = "https://help.instagram.com/1038071743007909";
const META_SAFE = "https://www.facebook.com/business/help/980593475366490";
const YOUTUBE_THUMB = "https://support.google.com/youtube/answer/72431";
const LINKEDIN_SHARE = "https://www.linkedin.com/help/linkedin/answer/a521928";

export const formatPresets: FormatPreset[] = [
  // Profiles -----------------------------------------------------------------
  profilePreset({
    id: "linkedin-profile",
    platform: "LinkedIn",
    label: "LinkedIn profile",
    size: 400,
    source: "https://www.linkedin.com/help/linkedin/answer/a521928",
    notes: ["400×400 is the common upload size; the platform renders a circle."],
  }),
  profilePreset({
    id: "facebook-profile",
    platform: "Facebook",
    label: "Facebook profile",
    size: 320,
    official: true,
    source: FACEBOOK_HELP,
    notes: ["Facebook's own help recommends 320×320 for the Page profile picture."],
  }),
  profilePreset({
    id: "instagram-profile",
    platform: "Instagram",
    label: "Instagram profile",
    size: 320,
    source: INSTAGRAM_PHOTO,
    notes: ["Instagram renders the profile picture as a circle."],
  }),
  profilePreset({
    id: "x-profile",
    platform: "X",
    label: "X profile",
    size: 400,
    source: "https://help.x.com/en/managing-your-account/profile-header-photos",
    notes: ["400×400 is the common upload size."],
  }),
  profilePreset({
    id: "tiktok-profile",
    platform: "TikTok",
    label: "TikTok profile",
    size: 200,
    source: "https://support.tiktok.com/en/using-tiktok/creating-videos",
    notes: ["200×200 is the upload size the app accepts without downscaling."],
  }),
  profilePreset({
    id: "youtube-profile",
    platform: "YouTube",
    label: "YouTube channel picture",
    size: 800,
    source: "https://support.google.com/youtube/answer/2972003",
    notes: ["800×800 keeps the channel picture sharp on TV and mobile."],
  }),

  // Covers and banners -------------------------------------------------------
  {
    id: "linkedin-cover",
    platform: "LinkedIn",
    group: "cover",
    label: "LinkedIn cover",
    width: 1584,
    height: 396,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 280, 40, 1230, 316)],
    crops: [
      { id: "mobile", label: "Mobile crop", x: 140, y: 0, width: 1300, height: 396 },
    ],
    exclusions: [profileExclusion(0, 236, 250, 160, "Profile photo")],
    defaultTemplate: "split-copy",
    notes: [
      "The profile photo covers the lower-left corner; keep the mark and copy right of it.",
      "1584×396 is the common 4:1 upload size; LinkedIn does not publish it as a hard requirement.",
    ],
    source: "https://www.linkedin.com/help/linkedin/answer/a521928",
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "linkedin-company-cover",
    platform: "LinkedIn",
    group: "cover",
    label: "LinkedIn company cover",
    width: 1128,
    height: 191,
    pixelUnit: 4,
    minTextSize: 16,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 200, 20, 880, 151)],
    crops: [],
    exclusions: [profileExclusion(0, 96, 170, 95, "Company logo")],
    defaultTemplate: "banner-copy",
    notes: [
      "1128×191 is the common company-page cover size; the logo overlaps the left edge.",
    ],
    source: "https://www.linkedin.com/help/linkedin/answer/a521928",
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "facebook-cover",
    platform: "Facebook",
    group: "cover",
    label: "Facebook cover",
    width: 851,
    height: 315,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 100_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 220, 28, 600, 259)],
    crops: [
      {
        id: "mobile",
        label: "Mobile 2.4:1 crop",
        x: 48,
        y: 0,
        width: 755,
        height: 315,
      },
    ],
    exclusions: [profileExclusion(0, 226, 190, 89, "Profile photo")],
    defaultTemplate: "split-copy",
    notes: [
      "Facebook loads fastest at 851×315 and under 100 KB; PNG is better for logos and text.",
      "Mobile crops to roughly 2.4:1 and the profile picture overlaps the left edge.",
    ],
    source: FACEBOOK_HELP,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "x-header",
    platform: "X",
    group: "cover",
    label: "X header",
    width: 1500,
    height: 500,
    pixelUnit: 4,
    minTextSize: 32,
    maxBytes: 5_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 270, 60, 960, 380)],
    crops: [],
    exclusions: [profileExclusion(0, 300, 260, 200, "Profile photo")],
    defaultTemplate: "banner-copy",
    notes: ["Keep copy away from the profile photo in the lower-left."],
    source: "https://help.x.com/en/managing-your-account/profile-header-photos",
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "youtube-banner",
    platform: "YouTube",
    group: "banner",
    label: "YouTube banner",
    width: 2048,
    height: 1152,
    pixelUnit: 8,
    minTextSize: 48,
    maxBytes: 6_000_000,
    shape: "rect",
    safeZones: [zone("safe", "TV-safe area", 406, 407, 1235, 338)],
    crops: [
      { id: "desktop", label: "Desktop", x: 256, y: 254, width: 1536, height: 644 },
      { id: "mobile", label: "Mobile", x: 678, y: 254, width: 692, height: 644 },
    ],
    exclusions: [],
    defaultTemplate: "centered-copy",
    notes: [
      "The TV-safe area is the only region every device shows; keep the mark and copy there.",
    ],
    source: "https://support.google.com/youtube/answer/2972003",
    verifiedAt: CHECKED,
    official: false,
  },

  // Feed posts ---------------------------------------------------------------
  {
    id: "instagram-post",
    platform: "Instagram",
    group: "post",
    label: "Instagram post",
    width: 1080,
    height: 1080,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [safe(1080, 1080, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "split-copy",
    notes: ["Instagram uploads up to 1080 px wide and keeps the original ratio."],
    source: INSTAGRAM_PHOTO,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "instagram-portrait",
    platform: "Instagram",
    group: "post",
    label: "Instagram portrait",
    width: 1080,
    height: 1350,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [safe(1080, 1350, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "stack-copy",
    notes: ["4:5 is the tallest ratio Instagram keeps without cropping."],
    source: INSTAGRAM_PHOTO,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "facebook-post",
    platform: "Facebook",
    group: "post",
    label: "Facebook post",
    width: 1080,
    height: 1080,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [safe(1080, 1080, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "split-copy",
    notes: ["A square post is safe in every Facebook placement."],
    source: FACEBOOK_HELP,
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "linkedin-post",
    platform: "LinkedIn",
    group: "post",
    label: "LinkedIn post",
    width: 1200,
    height: 627,
    pixelUnit: 4,
    minTextSize: 28,
    maxBytes: 5_000_000,
    shape: "rect",
    safeZones: [safe(1200, 627, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "split-copy",
    notes: ["1.91:1 is LinkedIn's recommended share ratio."],
    source: LINKEDIN_SHARE,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "x-post",
    platform: "X",
    group: "post",
    label: "X post",
    width: 1200,
    height: 675,
    pixelUnit: 4,
    minTextSize: 28,
    maxBytes: 5_000_000,
    shape: "rect",
    safeZones: [safe(1200, 675, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "split-copy",
    notes: ["16:9 is the common in-feed image ratio."],
    source: "https://help.x.com/en/managing-your-account/profile-header-photos",
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "threads-post",
    platform: "Threads",
    group: "post",
    label: "Threads post",
    width: 1080,
    height: 1350,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [safe(1080, 1350, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "stack-copy",
    notes: ["4:5 is the tallest common in-feed ratio."],
    source: "https://help.instagram.com/",
    verifiedAt: CHECKED,
    official: false,
  },
  {
    id: "pinterest-pin",
    platform: "Pinterest",
    group: "post",
    label: "Pinterest pin",
    width: 1000,
    height: 1500,
    pixelUnit: 4,
    minTextSize: 24,
    maxBytes: 10_000_000,
    shape: "rect",
    safeZones: [safe(1000, 1500, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "stack-copy",
    notes: ["2:3 is the standard vertical pin."],
    source: "https://help.pinterest.com/en/business/article/pin-specs",
    verifiedAt: CHECKED,
    official: false,
  },

  // Stories and vertical video ----------------------------------------------
  ...verticalPreset({
    id: "instagram-story",
    platform: "Instagram",
    label: "Instagram story",
    source: INSTAGRAM_REELS,
    official: true,
    notes: [
      "Stories cover the whole screen; keep copy out of the top and bottom UI bands.",
    ],
  }),
  ...verticalPreset({
    id: "instagram-reel",
    platform: "Instagram",
    label: "Instagram Reel cover frame",
    source: INSTAGRAM_REELS,
    official: true,
    notes: [
      "Reels accept 1.91:1 through 9:16; 1080×1920 is the safe 9:16 upload size.",
      "The grid shows a separate 420×654 cover image.",
    ],
  }),
  ...verticalPreset({
    id: "tiktok-video",
    platform: "TikTok",
    label: "TikTok video cover",
    source:
      "https://www.tiktok.com/creators/creator-bootcamp/en/content-creation-tips/tiktok-video-specifications/",
    official: false,
    notes: [
      "1080p or higher; 9:16 fills the For You feed.",
      "Keep copy clear of the right action rail and the bottom caption band.",
    ],
  }),
  ...verticalPreset({
    id: "youtube-shorts",
    platform: "YouTube",
    label: "YouTube Shorts thumbnail",
    source: YOUTUBE_THUMB,
    official: true,
    notes: ["Shorts thumbnails are 9:16, at least 640 px tall and under 2 MB on mobile."],
    maxBytes: 2_000_000,
  }),
  ...verticalPreset({
    id: "facebook-story",
    platform: "Facebook",
    label: "Facebook story",
    source: META_SAFE,
    official: false,
    notes: ["9:16 fills the story viewer; keep key elements out of the edges."],
  }),
  {
    id: "instagram-reel-cover",
    platform: "Instagram",
    group: "vertical",
    label: "Instagram Reel grid cover",
    width: 420,
    height: 654,
    pixelUnit: 2,
    minTextSize: 16,
    maxBytes: 8_000_000,
    shape: "rect",
    safeZones: [safe(420, 654, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "stack-copy",
    notes: [
      "Instagram recommends 420×654 (1:1.55) for the cover shown in the profile grid.",
      "This is separate from the 1080×1920 video frame.",
    ],
    source: INSTAGRAM_REELS,
    verifiedAt: CHECKED,
    official: true,
  },

  // Video thumbnails ---------------------------------------------------------
  {
    id: "youtube-thumbnail",
    platform: "YouTube",
    group: "video",
    label: "YouTube thumbnail",
    width: 1280,
    height: 720,
    pixelUnit: 4,
    minTextSize: 64,
    maxBytes: 2_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 48, 36, 1184, 550)],
    crops: [],
    exclusions: [zone("duration", "Duration badge", 1030, 604, 230, 100)],
    defaultTemplate: "thumbnail",
    notes: [
      "2 MB limit on mobile, minimum 640 px wide; 1280×720 is the standard upload.",
      "Keep the lower-right clear: YouTube draws the duration badge there.",
    ],
    source: YOUTUBE_THUMB,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "youtube-thumbnail-hd",
    platform: "YouTube",
    group: "video",
    label: "YouTube thumbnail HD",
    width: 1920,
    height: 1080,
    pixelUnit: 8,
    minTextSize: 96,
    maxBytes: 2_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 72, 54, 1776, 830)],
    crops: [],
    exclusions: [zone("duration", "Duration badge", 1545, 906, 345, 150)],
    defaultTemplate: "thumbnail",
    notes: ["Same 16:9 frame at 1080p; text must grow with the canvas."],
    source: YOUTUBE_THUMB,
    verifiedAt: CHECKED,
    official: true,
  },
  {
    id: "youtube-thumbnail-4k",
    platform: "YouTube",
    group: "video",
    label: "YouTube thumbnail 4K",
    width: 3840,
    height: 2160,
    pixelUnit: 16,
    minTextSize: 192,
    maxBytes: 2_000_000,
    shape: "rect",
    safeZones: [zone("safe", "Safe area", 144, 108, 3552, 1660)],
    crops: [],
    exclusions: [zone("duration", "Duration badge", 3090, 1812, 690, 300)],
    defaultTemplate: "thumbnail",
    notes: [
      "YouTube recommends 3840×2160 for the sharpest thumbnail, still under 2 MB on mobile.",
      "At this size the text is giant on purpose; use few words.",
    ],
    source: YOUTUBE_THUMB,
    verifiedAt: CHECKED,
    official: true,
  },

  // Link previews ------------------------------------------------------------
  {
    id: "og-image",
    platform: "Open Graph",
    group: "post",
    label: "Link preview (OG image)",
    width: 1200,
    height: 630,
    pixelUnit: 4,
    minTextSize: 28,
    maxBytes: 5_000_000,
    shape: "rect",
    safeZones: [safe(1200, 630, 0.06)],
    crops: [],
    exclusions: [],
    defaultTemplate: "split-copy",
    notes: ["1.91:1 is the common link-preview ratio across LinkedIn and Facebook."],
    source: LINKEDIN_SHARE,
    verifiedAt: CHECKED,
    official: true,
  },
];

function profileExclusion(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): Zone {
  return { id: "profile", label, x, y, width, height };
}

function verticalPreset(input: {
  id: string;
  platform: string;
  label: string;
  source: string;
  official: boolean;
  notes: string[];
  maxBytes?: number;
}): FormatPreset[] {
  return [
    {
      id: input.id,
      platform: input.platform,
      group: "vertical",
      label: input.label,
      width: 1080,
      height: 1920,
      pixelUnit: 4,
      minTextSize: 40,
      maxBytes: input.maxBytes ?? 8_000_000,
      shape: "rect",
      safeZones: [zone("safe", "Safe area", 96, 200, 780, 1200)],
      crops: [
        {
          id: "feed",
          label: "Feed 4:5 crop",
          x: 0,
          y: 285,
          width: 1080,
          height: 1350,
        },
      ],
      exclusions: [
        zone("rail", "Right action rail", 900, 460, 180, 960),
        zone("caption", "Bottom caption band", 0, 1460, 1080, 460),
        zone("top", "Top UI band", 0, 0, 1080, 180),
      ],
      defaultTemplate: "stack-copy",
      notes: [
        "9:16 full-screen. Keep the first three words readable at thumbnail size.",
        "The right rail and bottom caption cover the artwork in the app; the export keeps them.",
        ...input.notes,
      ],
      source: input.source,
      verifiedAt: CHECKED,
      official: input.official,
    },
  ];
}

export const presetById = new Map(formatPresets.map((preset) => [preset.id, preset]));

export function getPreset(id: string): FormatPreset {
  const preset = presetById.get(id);
  if (!preset) throw new Error(`Unknown format preset "${id}".`);
  return preset;
}

export function presetsByGroup(): Array<{
  group: FormatPreset["group"];
  label: string;
  presets: FormatPreset[];
}> {
  const labels: Record<FormatPreset["group"], string> = {
    profile: "Profiles",
    cover: "Covers & headers",
    post: "Feed posts",
    vertical: "Stories & vertical video",
    video: "Video thumbnails",
    banner: "Banners",
  };
  const order: FormatPreset["group"][] = [
    "profile",
    "cover",
    "post",
    "vertical",
    "video",
    "banner",
  ];
  return order.map((group) => ({
    group,
    label: labels[group],
    presets: formatPresets.filter((preset) => preset.group === group),
  }));
}

export function presetAspect(preset: Pick<FormatPreset, "width" | "height">): string {
  const divisor = greatestCommonDivisor(preset.width, preset.height);
  return `${preset.width / divisor}:${preset.height / divisor}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}
