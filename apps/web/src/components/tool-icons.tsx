import type { SVGProps } from "react";

function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SelectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path strokeDasharray="2 2" d="M2.5 2.5h11v11h-11z" />
    </Glyph>
  );
}

export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M2.5 13.5l1-3.5 7-7 2.5 2.5-7 7z" />
      <path d="M9.5 4l2.5 2.5" />
    </Glyph>
  );
}

export function EraserIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M3 11.5l4-4 5 5-2.5 2.5H5z" />
      <path d="M7 7.5l3.5-3.5a1.5 1.5 0 012 0l2 2a1.5 1.5 0 010 2L11 11.5" />
    </Glyph>
  );
}

export function FillIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M7 2.5L3 6.5l5 5 4-4z" />
      <path d="M12.5 8.5s1.5 2 1.5 3a1.5 1.5 0 01-3 0c0-1 1.5-3 1.5-3z" />
    </Glyph>
  );
}

export function PickerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M13 2.5a2 2 0 00-2.8 2.8L3 12.5 2.5 14.5l2-.5 7.2-7.2A2 2 0 0014.5 4z" />
    </Glyph>
  );
}

export function LineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M3 13L13 3" />
      <rect x="2" y="12" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="12" y="2" width="2" height="2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function RectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4" width="10" height="8" />
    </Glyph>
  );
}

export function PanIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M8 2v12M2 8h12" />
      <path d="M8 2L6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
    </Glyph>
  );
}
