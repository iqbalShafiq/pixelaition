import {
  ArrowRight as RawArrowRight,
  Attachment as RawAttachment,
  Check as RawCheck,
  CheckboxOn as RawCheckboxOn,
  ChevronDown as RawChevronDown,
  CircleInfo as RawCircleInfo,
  Clipboard as RawClipboard,
  Close as RawClose,
  ColorsSwatch as RawColorsSwatch,
  Copy as RawCopy,
  Download as RawDownload,
  Eraser as RawEraser,
  Eye as RawEye,
  EyeOff as RawEyeOff,
  FlipHorizontal2 as RawFlipHorizontal2,
  Folder as RawFolder,
  Grid3x3 as RawGrid3x3,
  Hand as RawHand,
  Layout as RawLayout,
  Logout as RawLogout,
  Menu as RawMenu,
  Minus as RawMinus,
  Pencil as RawPencil,
  Pipette as RawPipette,
  Play as RawPlay,
  Plus as RawPlus,
  Robot as RawRobot,
  Search as RawSearch,
  Send as RawSend,
  Square as RawSquare,
  Stop as RawStop,
  Tools as RawTools,
  Trash as RawTrash,
} from "pixelarticons/react";
import type { ComponentType, SVGProps } from "react";

/**
 * The app's icon set: pixelarticons on the 24x24 grid, wrapped by `crisp`.
 *
 * Audit, run from apps/web against pixelarticons 2.4.2:
 *
 *   node --input-type=module -e "import('pixelarticons/react').then(m =>
 *     console.log(Object.keys(m).sort().join('\n')))"
 *
 * Export            Replaces (old set)  pixelarticons export   Note
 * ---------------   -----------------   --------------------   --------------------------------
 * Pencil            Pencil              Pencil
 * Eraser            Eraser              Eraser
 * Picker            Pipette             Pipette
 * Square            Square              Square
 * Hand              Hand                Hand
 * Plus              Plus                Plus
 * Trash             Trash2              Trash
 * Copy              Copy                Copy
 * Play              Play                Play
 * Stop              (Square, playback)  Stop
 * Eye               Eye                 Eye
 * EyeOff            EyeOff              EyeOff
 * Folder            FolderOpen          Folder                 substitution: no FolderOpen
 * Clipboard         ClipboardCheck      Clipboard              substitution: no ClipboardCheck
 * Flip              FlipHorizontal      FlipHorizontal2        exact export is FlipHorizontal2
 * Wrench            Wrench              Tools                  substitution: no wrench glyph
 * Brain             Brain               Robot                  substitution: no brain glyph
 * Checklist         (plan rows)         CheckboxOn             substitution: no checklist glyph
 * Check             Check               Check
 * Close             X                   Close
 * Grid              Grid3X3             Grid3x3                exact export is Grid3x3 (lower x)
 * Export            (button label)      Download               substitution: no Export glyph
 * Menu              Menu                Menu
 * PanelLeft         (mobile rail)       Layout                 substitution: left-rail layout glyph
 * Send              (composer)          Send
 * Palette           Palette             ColorsSwatch           substitution: no Palette
 * ArrowRight        ArrowRight          ArrowRight
 * ChevronDown       ChevronDown         ChevronDown
 * Logout            (account menu)      Logout
 * Minus             Minus               Minus
 * Attach            (attach button)     Attachment
 * Info              (attachment hint)   CircleInfo
 * Search            (library search)    Search
 *
 * custom (the free set has no equivalent; drawn below on the same 24x24 grid
 * with 2x2 cells, no substitution is allowed here):
 *   Fill          replaces PaintBucket   bucket with a drip
 *   Line          replaces Slash         45-degree diagonal
 *   Select        replaces SquareDashed  dashed square
 *   Layers        replaces Layers        onion skin: stacked sheets
 *   Transparency  replaces SquareDashed  checker square
 *   Outline       (tool row)             hollow ring
 *   Dither        (tool row)             checkerboard
 *
 * Every pixelarticons component draws on 24x24 with fill="currentColor"
 * already; `crisp` fixes the render size and puts every edge on the grid.
 * The custom glyphs match that weight and render at 24 (2px cells) or 12
 * (1px cells); never 16 or 20, which would land edges off the device grid.
 */

export type IconProps = SVGProps<SVGSVGElement>;

/** Pixelarticons are 24x24; crispEdges keeps every edge on the grid. */
function crisp(Component: ComponentType<IconProps>) {
  return function CrispIcon(props: IconProps) {
    return <Component width={24} height={24} shapeRendering="crispEdges" {...props} />;
  };
}

export const Pencil = crisp(RawPencil);
export const Eraser = crisp(RawEraser);
export const Picker = crisp(RawPipette);
export const Square = crisp(RawSquare);
export const Hand = crisp(RawHand);
export const Plus = crisp(RawPlus);
export const Trash = crisp(RawTrash);
export const Copy = crisp(RawCopy);
export const Play = crisp(RawPlay);
export const Stop = crisp(RawStop);
export const Eye = crisp(RawEye);
export const EyeOff = crisp(RawEyeOff);
export const Folder = crisp(RawFolder);
export const Clipboard = crisp(RawClipboard);
export const Flip = crisp(RawFlipHorizontal2);
export const Wrench = crisp(RawTools);
export const Brain = crisp(RawRobot);
export const Checklist = crisp(RawCheckboxOn);
export const Check = crisp(RawCheck);
export const Close = crisp(RawClose);
export const Grid = crisp(RawGrid3x3);
export const Export = crisp(RawDownload);
export const Menu = crisp(RawMenu);
export const PanelLeft = crisp(RawLayout);
export const Send = crisp(RawSend);
export const Palette = crisp(RawColorsSwatch);
export const ArrowRight = crisp(RawArrowRight);
export const ChevronDown = crisp(RawChevronDown);
export const Logout = crisp(RawLogout);
export const Minus = crisp(RawMinus);
export const Attach = crisp(RawAttachment);
export const Info = crisp(RawCircleInfo);
export const Search = crisp(RawSearch);

/**
 * Draws a glyph from a bitmap: one character per 2x2 cell on the 24x24 grid,
 * so the stroke weight matches the pixelarticons next to it. "X" fills a cell.
 */
function glyph(rows: readonly string[]) {
  const unit = 2;
  return function Glyph({ width = 24, height = 24, ...props }: IconProps) {
    return (
      <svg
        aria-hidden
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="currentColor"
        shapeRendering="crispEdges"
        {...props}
      >
        {rows.flatMap((row, y) =>
          [...row].map((cell, x) =>
            cell === "X" ? (
              <rect
                key={`${x}-${y}`}
                x={x * unit}
                y={y * unit}
                width={unit}
                height={unit}
              />
            ) : null,
          ),
        )}
      </svg>
    );
  };
}

/** A blocky capital T for the common insert toolbar. */
export const Text = glyph([
  "............",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "....XXXX....",
  "............",
]);

/** Paint bucket: handle, tapering body, and a drip below. */
export const Fill = glyph([
  "............",
  "....XXXX....",
  "...X....X...",
  "...X....X...",
  "..XXXXXXXX..",
  "..XXXXXXXX..",
  "..XXXXXXXX..",
  "...XXXXXX...",
  "...XXXXXX...",
  "....XXXX....",
  "............",
  ".....XX.....",
]);

/** A 45-degree diagonal, the Line tool. */
export const Line = glyph([
  "..........XX",
  ".........XX.",
  "........XX..",
  ".......XX...",
  "......XX....",
  ".....XX.....",
  "....XX......",
  "...XX.......",
  "..XX........",
  ".XX.........",
  "XX..........",
  "............",
]);

/** Marching-ants dashed square, the Select tool. */
export const Select = glyph([
  "............",
  ".XX..XX..XX.",
  ".X........X.",
  "............",
  "............",
  ".X........X.",
  ".X........X.",
  "............",
  "............",
  ".X........X.",
  ".XX..XX..XX.",
  "............",
]);

/** Stacked sheets: a diamond over two chevrons, the onion-skin toggle. */
export const Layers = glyph([
  "............",
  ".....XX.....",
  "....XXXX....",
  "...XXXXXX...",
  "....XXXX....",
  ".....XX.....",
  "..XXXXXXXX..",
  "...XXXXXX...",
  "....XXXX....",
  "..XXXXXXXX..",
  "...XXXXXX...",
  "....XXXX....",
]);

/** Checker square, the transparency toggle. */
export const Transparency = glyph([
  "............",
  ".XX..XX..XX.",
  ".XX..XX..XX.",
  "...XX..XX...",
  "...XX..XX...",
  ".XX..XX..XX.",
  ".XX..XX..XX.",
  "...XX..XX...",
  "...XX..XX...",
  ".XX..XX..XX.",
  ".XX..XX..XX.",
  "............",
]);

/** Hollow ring, the outline tool. */
export const Outline = glyph([
  "............",
  "..XXXXXXXX..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..X......X..",
  "..XXXXXXXX..",
  "............",
]);

/** Checkerboard, the dither tool. */
export const Dither = glyph([
  "............",
  ".XX..XX..XX.",
  "XX..XX..XX..",
  ".XX..XX..XX.",
  "XX..XX..XX..",
  ".XX..XX..XX.",
  "XX..XX..XX..",
  ".XX..XX..XX.",
  "XX..XX..XX..",
  ".XX..XX..XX.",
  "XX..XX..XX..",
  "............",
]);
