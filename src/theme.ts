// 3D palette. Owned by the architect. UI colors live as CSS variables in index.css.
// Minimal: the space is white/near-white; color is reserved for data (priority, status, member, project).
export const PALETTE = {
  background: '#eef1f6',
  floor: '#f7f8fb',
  floorLine: '#eceff5',
  wall: '#ffffff',
  wallTrim: '#e3e7ef',
  glass: '#dbe6ff',
  /** Furniture: one light neutral family. */
  furniture: '#e6e9f0',
  furnitureDark: '#cfd5e1',
  deskTop: '#ffffff',
  screenOff: '#d7dce6',
  screenOn: '#9dbdff',
  /** The single structural accent (shelves, meeting room frame). */
  accent: '#3a63e0',
  accentSoft: '#c9d6fb',
  shadow: '#1b2333',
  selection: '#ffb020',
  hover: '#8fb0ff',
  dropOk: '#22b07d',
  overdueGlow: '#ff4d4f',
} as const
