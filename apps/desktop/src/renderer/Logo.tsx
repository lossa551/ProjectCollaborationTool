/** The Foreus mark: a person's piece and an agent's piece keyed together. Same shapes as build/logo.svg. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="6 6 52 52" aria-hidden="true">
      <path d="M6 18 A12 12 0 0 1 18 6 H24 V26 H36 V38 H24 V58 H18 A12 12 0 0 1 6 46 Z" fill="#f0a948" />
      <path d="M28 6 H46 A12 12 0 0 1 58 18 V46 A12 12 0 0 1 46 58 H28 V42 H40 V22 H28 Z" fill="#6c9bf2" />
    </svg>
  );
}
