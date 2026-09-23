import type { CSSProperties } from 'react';
import { ROLE_STYLE } from '@/lib/graph/roles';
import type { Role } from '@/lib/graph/types';

export function RoleSymbol({
  role,
  seed = false,
  large = false,
}: {
  role: Role;
  seed?: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={`role-symbol ${seed ? 'is-seed' : ''} ${large ? 'is-large' : ''}`}
      style={{ '--role-color': ROLE_STYLE[role].color } as CSSProperties}
      aria-hidden="true"
    >
      <span className={`role-shape shape-${ROLE_STYLE[role].shape}`} />
    </span>
  );
}
